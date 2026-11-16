/**
 * PumpSwap, pump.fun's own AMM, where a pump.fun token trades after its curve
 * completes.
 *
 * The canonical pool of a migrated mint is a PDA of the mint, so no pool
 * discovery is needed. State is the SDK's, read in one RPC round trip
 * (`swapStateInOneRead`); quotes use the SDK's constant-product maths with
 * the pool's fee tier; instructions are the SDK's. Buys spend exactly the
 * SOL the trader committed for at least the quoted tokens net of the slippage
 * allowance (`buy_exact_quote_in`): the exact-tokens `buy` would buy only
 * that floor, so a 20 % allowance would buy 20 % fewer tokens than asked.
 */

import { canonicalPumpPoolPda } from '@pump-fun/pump-sdk';
import {
  GLOBAL_CONFIG_PDA,
  OnlinePumpAmmSdk,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_SDK,
  buyQuoteInput,
  pumpAmmJson,
  sellBaseInput,
  type SwapSolanaState,
} from '@pump-fun/pump-swap-sdk';
import { Connection, PublicKey, TransactionInstruction, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT, assertOwnWsolPlumbing, associatedTokenAddress, type DecodedInstruction, type SolanaRpc } from './solana';
import { LaunchpadError, type BuiltSwap, type LaunchpadAdapter, type LaunchpadQuote, type LaunchpadQuoteRequest } from './types';

export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export interface PumpswapAdapterOptions {
  readonly rpc: SolanaRpc;
  /** Injectable for tests: how the swap state is read (one batched read by default, else the SDK's online reader). */
  readonly readState?: (poolKey: string, user: string, mint: string) => Promise<SwapSolanaState>;
  readonly now?: () => number;
  readonly computeUnits?: number;
}

const SWAP_COMPUTE_UNITS = 300_000;
const bn = (value: bigint): BN => new BN(value.toString());

/**
 * One web3 `Connection` per RPC URL for the whole process, so a server that makes an adapter per request does not set
 * up an HTTP agent again for every quote.
 */
const connections = new Map<string, Connection>();
function connectionFor(url: string): Connection {
  let connection = connections.get(url);
  if (!connection) {
    connection = new Connection(url, 'confirmed');
    connections.set(url, connection);
  }
  return connection;
}
const big = (value: BN): bigint => BigInt(value.toString());

/** The node's accounts for the keys, in order, null where there is none (web3's `getMultipleAccountsInfo`). */
export type AccountsRead = (keys: PublicKey[]) => Promise<(AccountInfo<Buffer> | null)[]>;

/** An SPL token account's balance (the same offset under both token programs). */
const tokenAmount = (data: Buffer): bigint => data.readBigUInt64LE(64);

/** The base mint layout (the first 82 bytes under both token programs), as `@solana/spl-token`'s `MintLayout` reads it. */
function decodeMint(data: Buffer): SwapSolanaState['baseMintAccount'] {
  if (data.length < 82) throw new Error('mint account is too short');
  return {
    mintAuthorityOption: data.readUInt32LE(0) as 0 | 1,
    mintAuthority: new PublicKey(data.subarray(4, 36)),
    supply: data.readBigUInt64LE(36),
    decimals: data.readUInt8(44),
    isInitialized: data.readUInt8(45) !== 0,
    freezeAuthorityOption: data.readUInt32LE(46) as 0 | 1,
    freezeAuthority: new PublicKey(data.subarray(50, 82)),
  };
}

/**
 * The SDK's swap state in one RPC round trip. `OnlinePumpAmmSdk.swapSolanaState` reads three times in a row (the
 * configs and the pool; then the mints and the pool's vaults; then the wallet's token accounts); one batched read of
 * the same accounts is one round trip instead of three. All but the configs derive from the mint: the canonical pool, and
 * its vaults and the wallet's accounts as associated token accounts, asked under both token programs because the
 * mint's owner (classic Token or Token-2022) picks one. The result is the object the SDK builds, refusals worded as
 * its own. A pool not quoted in SOL, or whose vault fields are not the derived accounts, is null here: the caller
 * reads that one the SDK's way.
 */
export async function swapStateInOneRead(read: AccountsRead, poolKey: PublicKey, mint: PublicKey, user: PublicKey): Promise<SwapSolanaState | null> {
  const pool58 = poolKey.toBase58();
  const mint58 = mint.toBase58();
  const user58 = user.toBase58();
  const ata = (owner: string, of: string, program: string): PublicKey => new PublicKey(associatedTokenAddress(owner, of, program));
  const keys = [
    GLOBAL_CONFIG_PDA,
    PUMP_AMM_FEE_CONFIG_PDA,
    poolKey,
    mint,
    new PublicKey(WSOL_MINT),
    ata(pool58, mint58, TOKEN_PROGRAM),
    ata(pool58, mint58, TOKEN_2022_PROGRAM),
    ata(pool58, WSOL_MINT, TOKEN_PROGRAM),
    ata(user58, mint58, TOKEN_PROGRAM),
    ata(user58, mint58, TOKEN_2022_PROGRAM),
    ata(user58, WSOL_MINT, TOKEN_PROGRAM),
  ];
  const infos = await read(keys);
  const [globalConfigInfo, feeConfigInfo, poolAccountInfo, baseMintInfo, quoteMintInfo, poolBaseToken, poolBase2022, poolQuoteInfo, userBaseToken, userBase2022, userQuoteInfo] = keys.map((_, i) => infos[i] ?? null);
  if (!globalConfigInfo) throw new Error('Global config account not found');
  if (!poolAccountInfo) throw new Error('Pool account not found');
  const pool = PUMP_AMM_SDK.decodePool(poolAccountInfo);
  if (pool.baseMint.toBase58() !== mint58 || pool.quoteMint.toBase58() !== WSOL_MINT) return null;
  if (!baseMintInfo) throw new Error(`baseMint=${mint58} not found`);
  if (!quoteMintInfo) throw new Error(`quoteMint=${WSOL_MINT} not found`);
  const baseProgram = baseMintInfo.owner.toBase58();
  if (baseProgram !== TOKEN_PROGRAM && baseProgram !== TOKEN_2022_PROGRAM) return null;
  const classic = baseProgram === TOKEN_PROGRAM;
  const poolBaseKey = keys[classic ? 5 : 6]!;
  const poolQuoteKey = keys[7]!;
  if (quoteMintInfo.owner.toBase58() !== TOKEN_PROGRAM) return null;
  if (pool.poolBaseTokenAccount.toBase58() !== poolBaseKey.toBase58() || pool.poolQuoteTokenAccount.toBase58() !== poolQuoteKey.toBase58()) return null;
  const poolBaseInfo = classic ? poolBaseToken : poolBase2022;
  if (!poolBaseInfo) throw new Error(`Pool base token account ${poolBaseKey.toBase58()} not found`);
  if (!poolQuoteInfo) throw new Error(`Pool quote token account ${poolQuoteKey.toBase58()} not found`);
  return {
    globalConfig: PUMP_AMM_SDK.decodeGlobalConfig(globalConfigInfo),
    feeConfig: feeConfigInfo ? PUMP_AMM_SDK.decodeFeeConfig(feeConfigInfo) : null,
    poolKey,
    poolAccountInfo,
    pool,
    poolBaseAmount: new BN(tokenAmount(poolBaseInfo.data).toString()),
    poolQuoteAmount: new BN(tokenAmount(poolQuoteInfo.data).toString()),
    baseTokenProgram: baseMintInfo.owner,
    quoteTokenProgram: quoteMintInfo.owner,
    baseMint: pool.baseMint,
    baseMintAccount: decodeMint(baseMintInfo.data),
    user,
    userBaseTokenAccount: keys[classic ? 8 : 9]!,
    userQuoteTokenAccount: keys[10]!,
    userBaseAccountInfo: (classic ? userBaseToken : userBase2022) ?? null,
    userQuoteAccountInfo: userQuoteInfo ?? null,
  };
}

/**
 * The SDK's buy as `buy_exact_quote_in`: the same accounts and layout, the committed SOL as the budget (fees come out
 * of it) and the slippage-net token amount as the floor, in that order.
 */
function asExactQuoteIn(instructions: TransactionInstruction[], quote: LaunchpadQuote): TransactionInstruction[] {
  const buy = discriminatorOf('buy');
  let budgeted = 0;
  const out = instructions.map((ix) => {
    if (ix.programId.toBase58() !== PUMPSWAP_PROGRAM || !ix.data.subarray(0, 8).equals(buy)) return ix;
    budgeted += 1;
    const data = Buffer.from(ix.data);
    discriminatorOf('buy_exact_quote_in').copy(data, 0);
    data.writeBigUInt64LE(quote.inAmount, 8);
    data.writeBigUInt64LE(quote.minOutAmount, 16);
    return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
  });
  if (budgeted !== 1) throw new LaunchpadError('pumpswap', 'STATE_UNAVAILABLE', `expected one PumpSwap buy to budget, found ${budgeted}`);
  return out;
}

function discriminatorOf(name: string): Buffer {
  const instruction = (pumpAmmJson as { instructions: { name: string; discriminator: number[] }[] }).instructions.find((ix) => ix.name === name);
  if (!instruction) throw new Error(`pump_amm IDL has no instruction ${name}`);
  return Buffer.from(instruction.discriminator);
}

export class PumpswapAdapter implements LaunchpadAdapter {
  readonly venue = 'pumpswap' as const;
  readonly programs = [PUMPSWAP_PROGRAM] as const;
  private readonly now: () => number;
  private readonly readState: (poolKey: string, user: string, mint: string) => Promise<SwapSolanaState>;

  constructor(private readonly options: PumpswapAdapterOptions) {
    this.now = options.now ?? Date.now;
    this.readState =
      options.readState ??
      (async (poolKey, user, mint) => {
        const connection = connectionFor(options.rpc.url);
        const state = await swapStateInOneRead((keys) => connection.getMultipleAccountsInfo(keys), new PublicKey(poolKey), new PublicKey(mint), new PublicKey(user));
        return state ?? new OnlinePumpAmmSdk(connection).swapSolanaState(new PublicKey(poolKey), new PublicKey(user));
      });
  }

  static canonicalPool(mint: string): string {
    return canonicalPumpPoolPda(new PublicKey(mint)).toBase58();
  }

  async quote(request: LaunchpadQuoteRequest): Promise<LaunchpadQuote> {
    const poolKey = PumpswapAdapter.canonicalPool(request.mint);
    let state: SwapSolanaState;
    try {
      state = await this.readState(poolKey, request.user, request.mint);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A mint with no canonical pool is not an RPC failure: it has not migrated here (or never was a pump.fun token).
      const code = /Pool account not found/i.test(message) ? 'NOT_ON_CURVE' : 'STATE_UNAVAILABLE';
      throw new LaunchpadError('pumpswap', code, `${request.mint}: ${message}`);
    }
    return this.quoteFrom(state, request);
  }

  /** Pure: the quote for a request against a state already read. */
  quoteFrom(state: SwapSolanaState, request: LaunchpadQuoteRequest): LaunchpadQuote {
    if (!state.poolAccountInfo) throw new LaunchpadError('pumpswap', 'NOT_ON_CURVE', `${request.mint} has no canonical PumpSwap pool`);
    if (state.pool.baseMint.toBase58() !== request.mint) throw new LaunchpadError('pumpswap', 'STATE_UNAVAILABLE', 'pool is for another mint');
    if (state.pool.quoteMint.toBase58() !== WSOL_MINT) throw new LaunchpadError('pumpswap', 'UNSUPPORTED', `${request.mint} pool is quoted in ${state.pool.quoteMint.toBase58()}, not SOL`);
    if (request.amountIn <= 0n) throw new LaunchpadError('pumpswap', 'AMOUNT', 'amount must be positive');
    if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 10_000) throw new LaunchpadError('pumpswap', 'AMOUNT', 'slippage out of range');
    const quotedAt = this.now();
    const common = {
      slippage: 0,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
      quoteMint: state.pool.quoteMint,
      isMayhemMode: state.pool.isMayhemMode,
      creatorFeeBps: state.pool.creatorFeeBps,
    };
    if (request.side === 'buy') {
      const result = buyQuoteInput({ ...common, quote: bn(request.amountIn) });
      const base = big(result.base);
      if (base <= 0n) throw new LaunchpadError('pumpswap', 'AMOUNT', 'amount buys no tokens');
      const minOut = (base * BigInt(10_000 - request.slippageBps)) / 10_000n;
      if (minOut <= 0n) throw new LaunchpadError('pumpswap', 'AMOUNT', 'slippage leaves no tokens');
      return {
        venue: 'pumpswap',
        side: 'buy',
        mint: request.mint,
        inAmount: request.amountIn,
        outAmount: base,
        minOutAmount: minOut,
        slippageBps: request.slippageBps,
        venueFeeLamports: request.amountIn - big(result.internalQuoteWithoutFees) > 0n ? request.amountIn - big(result.internalQuoteWithoutFees) : 0n,
        priceImpactBps: impactBps(big(state.poolQuoteAmount) + big(state.pool.virtualQuoteReserves), request.amountIn),
        state,
        quotedAt,
      };
    }
    const result = sellBaseInput({ ...common, base: bn(request.amountIn) });
    const lamports = big(result.uiQuote);
    if (lamports <= 0n) throw new LaunchpadError('pumpswap', 'AMOUNT', 'amount sells for no SOL');
    const minOut = (lamports * BigInt(10_000 - request.slippageBps)) / 10_000n;
    return {
      venue: 'pumpswap',
      side: 'sell',
      mint: request.mint,
      inAmount: request.amountIn,
      outAmount: lamports,
      minOutAmount: minOut,
      slippageBps: request.slippageBps,
      venueFeeLamports: big(result.internalQuoteAmountOut) - lamports > 0n ? big(result.internalQuoteAmountOut) - lamports : 0n,
      priceImpactBps: null,
      state,
      quotedAt,
    };
  }

  async build(quote: LaunchpadQuote, _user: string): Promise<BuiltSwap> {
    const state = quote.state as SwapSolanaState;
    const instructions =
      quote.side === 'buy'
        ? asExactQuoteIn(await PUMP_AMM_SDK.buyInstructions(state, bn(quote.minOutAmount), bn(quote.inAmount)), quote)
        : await PUMP_AMM_SDK.sellInstructions(state, bn(quote.inAmount), bn(quote.minOutAmount));
    return { instructions, computeUnits: this.options.computeUnits ?? SWAP_COMPUTE_UNITS };
  }

  verify(instructions: readonly DecodedInstruction[], quote: LaunchpadQuote, user: string): void {
    const swaps = instructions.filter((ix) => ix.programId === PUMPSWAP_PROGRAM);
    if (swaps.length !== 1) throw new Error(`expected one PumpSwap instruction, found ${swaps.length}`);
    for (const ix of instructions) {
      if (ix.programId === PUMPSWAP_PROGRAM) continue;
      // The SDK wraps the wallet's SOL for the swap and unwraps it after; nothing else may ride along.
      assertOwnWsolPlumbing(ix, user);
    }
    const swap = swaps[0]!;
    const name = quote.side === 'buy' ? 'buy_exact_quote_in' : 'sell';
    if (swap.data.length < 24 || !swap.data.subarray(0, 8).equals(discriminatorOf(name))) throw new Error(`PumpSwap instruction is not ${name}`);
    const first = swap.data.readBigUInt64LE(8);
    const second = swap.data.readBigUInt64LE(16);
    if (quote.side === 'buy') {
      if (first !== quote.inAmount) throw new Error('buy SOL budget differs from the committed amount');
      if (second !== quote.minOutAmount) throw new Error('buy token floor differs from the quote');
    } else {
      if (first !== quote.inAmount) throw new Error('sell base amount differs from the quote');
      if (second !== quote.minOutAmount) throw new Error('sell SOL floor differs from the quote');
    }
    const state = quote.state as SwapSolanaState;
    if (!swap.accounts.includes(state.poolKey.toBase58())) throw new Error('instruction does not reference the canonical pool');
    if (!swap.accounts.includes(quote.mint)) throw new Error('instruction does not reference the quoted mint');
    if (!swap.accounts.includes(user)) throw new Error('instruction does not reference the wallet');
  }
}

/** Spot after over spot before for a constant-product buy, in basis points. */
function impactBps(quoteReserve: bigint, quoteIn: bigint): number | null {
  if (quoteReserve <= 0n) return null;
  // price ∝ quote / base; after the buy quote grows by `in` and base shrinks by the same k-ratio: impact ≈ ((q+in)/q)^2 − 1.
  const ratio = ((quoteReserve + quoteIn) * (quoteReserve + quoteIn) * 10_000n) / (quoteReserve * quoteReserve);
  return Number(ratio - 10_000n);
}
