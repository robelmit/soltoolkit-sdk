/**
 * Meteora Dynamic Bonding Curve, the curve program behind launchpads such as
 * Bags and Believe.
 *
 * A DBC pool is found by its base mint; its config holds the curve, the
 * fee schedule and the quote mint. Quotes use Meteora's `swapQuote`
 * (ExactIn) and instructions come from Meteora's `swap`. Only SOL-quoted
 * pools are traded; a migrated pool is refused with `MIGRATED`, so the
 * caller can send the trade to an aggregator instead.
 */

import { DynamicBondingCurveClient, getCurrentPoint, swapQuote, type PoolConfig, type VirtualPool } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { createHash } from 'node:crypto';
import { WSOL_MINT, assertOwnWsolPlumbing, type DecodedInstruction, type SolanaRpc } from './solana';
import { LaunchpadError, type BuiltSwap, type LaunchpadAdapter, type LaunchpadQuote, type LaunchpadQuoteRequest } from './types';

export const METEORA_DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

export interface MeteoraDbcState {
  readonly poolKey: string;
  readonly pool: VirtualPool;
  readonly config: PoolConfig;
  /** Slot or timestamp the fee scheduler is evaluated at (the config's activation type). */
  readonly currentPoint: bigint;
}

export interface MeteoraDbcAdapterOptions {
  readonly rpc: SolanaRpc;
  /** Injectable for tests: how the pool state is read (Meteora's client by default). */
  readonly readState?: (mint: string) => Promise<MeteoraDbcState>;
  /** Injectable for tests: how the swap instructions are built (Meteora's client by default). */
  readonly buildSwap?: (params: { pool: string; user: string; amountIn: bigint; minimumAmountOut: bigint; swapBaseForQuote: boolean }) => Promise<TransactionInstruction[]>;
  readonly now?: () => number;
  readonly computeUnits?: number;
}

const SWAP_COMPUTE_UNITS = 300_000;
const bn = (value: bigint): BN => new BN(value.toString());
const big = (value: BN): bigint => BigInt(value.toString());
/** Anchor's instruction discriminator: the first eight bytes of sha256("global:<name>"). */
export const SWAP_DISCRIMINATOR = createHash('sha256').update('global:swap').digest().subarray(0, 8);

export class MeteoraDbcAdapter implements LaunchpadAdapter {
  readonly venue = 'meteora-dbc' as const;
  readonly programs = [METEORA_DBC_PROGRAM] as const;
  private readonly now: () => number;
  private readonly client: DynamicBondingCurveClient | null;
  private readonly connection: Connection | null;

  constructor(private readonly options: MeteoraDbcAdapterOptions) {
    this.now = options.now ?? Date.now;
    const needsClient = !options.readState || !options.buildSwap;
    this.connection = needsClient ? new Connection(options.rpc.url, 'confirmed') : null;
    this.client = this.connection ? new DynamicBondingCurveClient(this.connection, 'confirmed') : null;
  }

  /** The pool by its address when the caller knows it (one read), else the program scan by base mint. */
  async readState(mint: string, poolHint?: string): Promise<MeteoraDbcState> {
    if (this.options.readState) return this.options.readState(mint);
    const client = this.client!;
    let found: { publicKey: PublicKey; account: VirtualPool } | null = null;
    if (poolHint) {
      const account = await client.state.getPool(new PublicKey(poolHint)).catch(() => null);
      if (account && account.poolState.baseMint.toBase58() === mint) found = { publicKey: new PublicKey(poolHint), account };
    }
    if (!found) found = await client.state.getPoolByBaseMint(new PublicKey(mint));
    if (!found) throw new LaunchpadError('meteora-dbc', 'NOT_ON_CURVE', `${mint} has no dynamic bonding curve pool`);
    const config = await client.state.getPoolConfig(found.account.poolState.config);
    if (!config) throw new LaunchpadError('meteora-dbc', 'STATE_UNAVAILABLE', `${mint}: pool config missing`);
    const currentPoint = await getCurrentPoint(this.connection!, config.activationType);
    return { poolKey: found.publicKey.toBase58(), pool: found.account, config, currentPoint: big(currentPoint) };
  }

  async quote(request: LaunchpadQuoteRequest): Promise<LaunchpadQuote> {
    const state = await this.readState(request.mint, request.pool);
    return this.quoteFrom(state, request);
  }

  quoteFrom(state: MeteoraDbcState, request: LaunchpadQuoteRequest): LaunchpadQuote {
    const { config } = state;
    const pool = state.pool.poolState;
    if (pool.baseMint.toBase58() !== request.mint) throw new LaunchpadError('meteora-dbc', 'STATE_UNAVAILABLE', 'pool is for another mint');
    if (config.quoteMint.toBase58() !== WSOL_MINT) throw new LaunchpadError('meteora-dbc', 'UNSUPPORTED', `${request.mint} is quoted in ${config.quoteMint.toBase58()}, not SOL`);
    if (pool.isMigrated !== 0) throw new LaunchpadError('meteora-dbc', 'MIGRATED', `${request.mint} has migrated; trade it on its AMM pool or an aggregator`);
    if (request.amountIn <= 0n) throw new LaunchpadError('meteora-dbc', 'AMOUNT', 'amount must be positive');
    if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 10_000) throw new LaunchpadError('meteora-dbc', 'AMOUNT', 'slippage out of range');
    const swapBaseForQuote = request.side === 'sell';
    let quoted: { amountOut: bigint; feeLamports: bigint };
    try {
      quoted = quoteWithSdk(state, swapBaseForQuote, request.amountIn, request.slippageBps);
    } catch (error) {
      // Meteora's maths refuses what the pool cannot fill (an empty quote vault, a curve overrun).
      throw new LaunchpadError('meteora-dbc', 'AMOUNT', error instanceof Error ? error.message : String(error));
    }
    const out = quoted.amountOut;
    if (out <= 0n) throw new LaunchpadError('meteora-dbc', 'AMOUNT', request.side === 'buy' ? 'amount buys no tokens' : 'amount sells for no SOL');
    const minOut = (out * BigInt(10_000 - request.slippageBps)) / 10_000n;
    if (minOut <= 0n) throw new LaunchpadError('meteora-dbc', 'AMOUNT', 'slippage leaves nothing');
    return {
      venue: 'meteora-dbc',
      side: request.side,
      mint: request.mint,
      inAmount: request.amountIn,
      outAmount: out,
      minOutAmount: minOut,
      slippageBps: request.slippageBps,
      venueFeeLamports: quoted.feeLamports,
      priceImpactBps: null,
      state,
      quotedAt: this.now(),
    };
  }

  async build(quote: LaunchpadQuote, user: string): Promise<BuiltSwap> {
    const state = quote.state as MeteoraDbcState;
    const params = { pool: state.poolKey, user, amountIn: quote.inAmount, minimumAmountOut: quote.minOutAmount, swapBaseForQuote: quote.side === 'sell' };
    const instructions = this.options.buildSwap
      ? await this.options.buildSwap(params)
      : (
          await this.client!.pool.swap({
            owner: new PublicKey(user),
            pool: new PublicKey(state.poolKey),
            amountIn: bn(quote.inAmount),
            minimumAmountOut: bn(quote.minOutAmount),
            swapBaseForQuote: quote.side === 'sell',
            referralTokenAccount: null,
          })
        ).instructions;
    return { instructions, computeUnits: this.options.computeUnits ?? SWAP_COMPUTE_UNITS };
  }

  verify(instructions: readonly DecodedInstruction[], quote: LaunchpadQuote, user: string): void {
    const swaps = instructions.filter((ix) => ix.programId === METEORA_DBC_PROGRAM);
    if (swaps.length !== 1) throw new Error(`expected one DBC swap instruction, found ${swaps.length}`);
    for (const ix of instructions) {
      if (ix.programId === METEORA_DBC_PROGRAM) continue;
      // Meteora's client wraps SOL for the trader and unwraps it after; nothing else may ride along.
      assertOwnWsolPlumbing(ix, user);
    }
    const swap = swaps[0]!;
    if (swap.data.length < 24 || !swap.data.subarray(0, 8).equals(SWAP_DISCRIMINATOR)) throw new Error('DBC instruction is not swap');
    if (swap.data.readBigUInt64LE(8) !== quote.inAmount) throw new Error('swap amount differs from the quote');
    if (swap.data.readBigUInt64LE(16) !== quote.minOutAmount) throw new Error('swap floor differs from the quote');
    const state = quote.state as MeteoraDbcState;
    if (!swap.accounts.includes(state.poolKey)) throw new Error('instruction does not reference the pool');
    if (!swap.accounts.includes(user)) throw new Error('instruction does not reference the wallet');
  }
}

/** Meteora's ExactIn quote: pure maths over the pool, its config and the current point. */
function quoteWithSdk(state: MeteoraDbcState, swapBaseForQuote: boolean, amountIn: bigint, slippageBps: number): { amountOut: bigint; feeLamports: bigint } {
  const result = swapQuote(state.pool, state.config, swapBaseForQuote, bn(amountIn), slippageBps, false, bn(state.currentPoint), false);
  const fee = big(result.tradingFee) + big(result.protocolFee) + big(result.referralFee);
  return { amountOut: big(result.outputAmount), feeLamports: fee };
}
