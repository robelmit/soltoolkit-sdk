/**
 * One entry point over every venue: quote, build an unsigned transaction, and
 * check the bytes before a wallet signs them.
 *
 *   const launchpads = createLaunchpads({ rpcUrl });
 *   const quote = await launchpads.quote({ side: 'buy', mint, amountIn: 10_000_000n, slippageBps: 300, user });
 *   const { transaction } = await launchpads.buildTransaction(quote, user);
 *   // ...hand `transaction` to the wallet; on the signing side, before signing:
 *   launchpads.verifyTransaction(transaction, quote, user);
 *
 * Nothing here signs or sends.
 */

import type { VersionedTransaction } from '@solana/web3.js';
import { MeteoraDbcAdapter } from './meteora-dbc';
import { PumpfunAdapter } from './pumpfun';
import { PumpswapAdapter } from './pumpswap';
import { COMPUTE_BUDGET_PROGRAM, MAX_COMPUTE_UNITS, SolanaRpc, assembleTransaction, computeBudgetInstructions, computeBudgetOf, decodeInstructions, decodeTransaction, encodeTransaction } from './solana';
import { LaunchpadError, type LaunchpadAdapter, type LaunchpadQuote, type LaunchpadQuoteRequest, type Venue } from './types';

/**
 * The order a token is looked for when no venue is named: the order of a
 * pump.fun token's life (curve, then its AMM), then Meteora's curve, whose
 * lookup is the most expensive (a program scan when no pool is given).
 */
export const VENUE_ORDER: readonly Venue[] = ['pumpfun', 'pumpswap', 'meteora-dbc'];

/** The most a transaction may pay in priority fee unless the caller says otherwise: 0.01 SOL. */
export const DEFAULT_MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n;

export interface LaunchpadsOptions {
  /** A Solana JSON-RPC endpoint. Give this or `rpc`. */
  readonly rpcUrl?: string;
  readonly rpc?: SolanaRpc;
  /** Replace or add adapters (tests, or a venue of your own). */
  readonly adapters?: Partial<Record<Venue, LaunchpadAdapter>>;
}

export interface BuildTransactionOptions {
  /** Paid to the validator on top of the base fee, in lamports for the whole transaction. Default 0. */
  readonly priorityFeeLamports?: bigint;
  /** Compute unit limit. Default: what the venue's adapter says the swap needs. */
  readonly computeUnits?: number;
  /** A recent blockhash you already hold; read from the RPC when absent. */
  readonly recentBlockhash?: string;
}

export interface BuiltTransaction {
  /** Unsigned. The wallet in `user` is the only signer and the fee payer. */
  readonly transaction: VersionedTransaction;
  /** The same transaction, base64, as wallets and RPC nodes take it. */
  readonly base64: string;
  readonly computeUnits: number;
  readonly priorityFeeLamports: bigint;
  readonly recentBlockhash: string;
  /** The block height after which the blockhash expires; null when the caller supplied the blockhash. */
  readonly lastValidBlockHeight: number | null;
}

export interface VerifyTransactionOptions {
  /** Refuse a transaction that pays more priority fee than this. Default 0.01 SOL. */
  readonly maxPriorityFeeLamports?: bigint;
}

/** No venue has this token. `attempts` says what each one answered. */
export class NoVenueError extends Error {
  constructor(
    readonly mint: string,
    readonly attempts: readonly LaunchpadError[],
  ) {
    super(`${mint} is not tradable on ${attempts.map((a) => `${a.venue} (${a.code})`).join(', ')}`);
    this.name = 'NoVenueError';
  }
}

export class Launchpads {
  readonly rpc: SolanaRpc;
  private readonly adapters: Record<Venue, LaunchpadAdapter>;

  constructor(options: LaunchpadsOptions) {
    if (options.rpc) this.rpc = options.rpc;
    else if (options.rpcUrl) this.rpc = new SolanaRpc({ url: options.rpcUrl });
    else throw new Error('createLaunchpads needs rpcUrl or rpc');
    const rpc = this.rpc;
    this.adapters = {
      pumpfun: options.adapters?.pumpfun ?? new PumpfunAdapter({ rpc }),
      pumpswap: options.adapters?.pumpswap ?? new PumpswapAdapter({ rpc }),
      'meteora-dbc': options.adapters?.['meteora-dbc'] ?? new MeteoraDbcAdapter({ rpc }),
    };
  }

  adapter(venue: Venue): LaunchpadAdapter {
    const adapter = this.adapters[venue];
    if (!adapter) throw new Error(`unknown venue ${String(venue)}`);
    return adapter;
  }

  /**
   * A quote from the named venue, or from the first venue that has the token.
   * Without a venue, one that answers "not here" (`NOT_ON_CURVE`) or "moved
   * on" (`MIGRATED`) hands over to the next; any other refusal is the answer
   * and is thrown as it is, so an RPC failure is never read as "not listed".
   */
  async quote(request: LaunchpadQuoteRequest, venue?: Venue): Promise<LaunchpadQuote> {
    if (venue) return this.adapter(venue).quote(request);
    const attempts: LaunchpadError[] = [];
    for (const candidate of VENUE_ORDER) {
      try {
        return await this.adapter(candidate).quote(request);
      } catch (error) {
        if (!(error instanceof LaunchpadError) || (error.code !== 'NOT_ON_CURVE' && error.code !== 'MIGRATED')) throw error;
        attempts.push(error);
      }
    }
    throw new NoVenueError(request.mint, attempts);
  }

  /**
   * The unsigned transaction for a quote: a compute budget and the venue's
   * swap, nothing else. It is serialized, read back and verified before it is
   * returned, so a transaction that leaves here is one `verifyTransaction`
   * accepts.
   */
  async buildTransaction(quote: LaunchpadQuote, user: string, options: BuildTransactionOptions = {}): Promise<BuiltTransaction> {
    const built = await this.adapter(quote.venue).build(quote, user);
    const computeUnits = options.computeUnits ?? built.computeUnits;
    const priorityFeeLamports = options.priorityFeeLamports ?? 0n;
    let recentBlockhash = options.recentBlockhash;
    let lastValidBlockHeight: number | null = null;
    if (!recentBlockhash) {
      const latest = await this.rpc.getLatestBlockhash();
      recentBlockhash = latest.blockhash;
      lastValidBlockHeight = latest.lastValidBlockHeight;
    }
    const transaction = assembleTransaction(user, recentBlockhash, [...computeBudgetInstructions(computeUnits, priorityFeeLamports), ...built.instructions]);
    const base64 = encodeTransaction(transaction);
    // Checked on the bytes, not on the objects they were made from. The unit price rounds up, which can add up to two lamports.
    this.verifyTransaction(base64, quote, user, { maxPriorityFeeLamports: priorityFeeLamports + 2n });
    return { transaction, base64, computeUnits, priorityFeeLamports, recentBlockhash, lastValidBlockHeight };
  }

  /**
   * Check that a transaction is this quote's swap for this wallet and nothing
   * else. Throws when it is not. Run it where the signing happens, on the
   * bytes about to be signed.
   *
   * It refuses: a fee payer or signer other than the wallet, address lookup
   * tables, a priority fee above the limit, more than one swap, a different
   * mint, amount or floor, and any instruction that is not the venue's swap or
   * the wallet's own token-account plumbing.
   */
  verifyTransaction(transaction: VersionedTransaction | Uint8Array | string, quote: LaunchpadQuote, user: string, options: VerifyTransactionOptions = {}): void {
    const tx = typeof transaction === 'string' ? decodeTransaction(transaction) : transaction instanceof Uint8Array ? decodeTransaction(Buffer.from(transaction).toString('base64')) : transaction;
    const message = tx.message;
    if (message.header.numRequiredSignatures !== 1) throw new Error(`transaction needs ${message.header.numRequiredSignatures} signatures; expected the wallet alone`);
    if (message.staticAccountKeys[0]?.toBase58() !== user) throw new Error('fee payer is not the wallet');
    const instructions = decodeInstructions(tx);

    const budget = instructions.filter((ix) => ix.programId === COMPUTE_BUDGET_PROGRAM);
    let limits = 0;
    let prices = 0;
    for (const ix of budget) {
      if (ix.data[0] === 2 && ix.data.length === 5) limits += 1;
      else if (ix.data[0] === 3 && ix.data.length === 9) prices += 1;
      else throw new Error('unexpected compute budget instruction');
    }
    if (limits > 1 || prices > 1) throw new Error('compute budget is set more than once');
    const { units, microLamportsPerUnit, priorityFeeLamports } = computeBudgetOf(budget);
    if (units !== null && (units < 1 || units > MAX_COMPUTE_UNITS)) throw new Error(`compute units out of range: ${units}`);
    if (microLamportsPerUnit !== null && microLamportsPerUnit > 0n) {
      // A price without a limit is paid on a limit the runtime picks; refuse what cannot be bounded from the bytes.
      if (priorityFeeLamports === null) throw new Error('priority fee is set without a compute unit limit');
      const max = options.maxPriorityFeeLamports ?? DEFAULT_MAX_PRIORITY_FEE_LAMPORTS;
      if (priorityFeeLamports > max) throw new Error(`priority fee ${priorityFeeLamports} lamports is above the limit ${max}`);
    }

    this.adapter(quote.venue).verify(
      instructions.filter((ix) => ix.programId !== COMPUTE_BUDGET_PROGRAM),
      quote,
      user,
    );
  }
}

export function createLaunchpads(options: LaunchpadsOptions): Launchpads {
  return new Launchpads(options);
}
