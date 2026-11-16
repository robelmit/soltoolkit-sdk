/**
 * PumpSwap and Meteora DBC adapters against recorded mainnet states:
 * quotes with each venue's own maths, instructions re-read before signing, and
 * the refusals (migrated pool, other quote mints) a caller relies on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import type { SwapSolanaState } from '@pump-fun/pump-swap-sdk';
import { swapQuote } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { METEORA_DBC_PROGRAM, MeteoraDbcAdapter, SWAP_DISCRIMINATOR, type MeteoraDbcState } from '../src/meteora-dbc';
import { PUMPSWAP_PROGRAM, PumpswapAdapter } from '../src/pumpswap';
import { assembleTransaction, decodeInstructions, type SolanaRpc } from '../src/solana';

const NOW = 1_790_000_000_000;
const rpc = { url: 'https://rpc.invalid' } as unknown as SolanaRpc;

/** Rehydrates the recorder's tagged JSON: `{$pk}` → PublicKey, `{$bn}` → BN, `{$buf}` → Buffer. */
function hydrate(value: unknown, key?: string, parent?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => hydrate(v));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o['$pk'] === 'string') return new PublicKey(o['$pk']);
    if (typeof o['$bn'] === 'string') return parent === 'baseMintAccount' && key === 'supply' ? BigInt(o['$bn']) : new BN(o['$bn']);
    if (typeof o['$buf'] === 'string') return Buffer.from(o['$buf'], 'base64');
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = hydrate(v, k, key);
    return out;
  }
  return value;
}

function fixture<T>(name: string): { mint: string; user: string; state: T } {
  const raw = JSON.parse(readFileSync(join(__dirname, '../src/__fixtures__', name), 'utf8')) as { mint: string; user: string; state: unknown };
  return { mint: raw.mint, user: raw.user, state: hydrate(raw.state) as T };
}

describe('PumpswapAdapter', () => {
  const pool = fixture<SwapSolanaState>('pumpswap-pool.json');
  const adapter = new PumpswapAdapter({ rpc, readState: async () => pool.state, now: () => NOW });

  it('quotes a budgeted buy and a sell from the recorded canonical pool', async () => {
    expect(PumpswapAdapter.canonicalPool(pool.mint)).toBe(pool.state.poolKey.toBase58());
    const buy = await adapter.quote({ side: 'buy', mint: pool.mint, amountIn: 100_000_000n, slippageBps: 100, user: pool.user });
    expect(buy).toMatchObject({ venue: 'pumpswap', side: 'buy', inAmount: 100_000_000n, slippageBps: 100, quotedAt: NOW });
    expect(buy.outAmount).toBeGreaterThan(0n);
    expect(buy.minOutAmount).toBe((buy.outAmount * 9_900n) / 10_000n);
    // ~3.6 SOL of real quote plus ~17.6 SOL virtual against 838M tokens: 0.1 SOL buys a few million tokens.
    const tokens = Number(buy.outAmount) / 1e6;
    expect(tokens).toBeGreaterThan(1_000_000);
    expect(tokens).toBeLessThan(10_000_000);
    expect(buy.venueFeeLamports).toBeGreaterThan(0n);
    expect(buy.priceImpactBps).toBeGreaterThan(0);
    const sell = await adapter.quote({ side: 'sell', mint: pool.mint, amountIn: buy.outAmount, slippageBps: 100, user: pool.user });
    expect(sell.outAmount).toBeLessThan(100_000_000n);
    expect(sell.outAmount).toBeGreaterThan(90_000_000n);
    expect(sell.minOutAmount).toBe((sell.outAmount * 9_900n) / 10_000n);
  });

  it('builds the venue SDK buy and sell instructions and verifies them against the quote', async () => {
    const buy = await adapter.quote({ side: 'buy', mint: pool.mint, amountIn: 100_000_000n, slippageBps: 100, user: pool.user });
    const built = await adapter.build(buy, pool.user);
    const instructions = decodeInstructions(assembleTransaction(pool.user, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', built.instructions));
    const swap = instructions.find((ix) => ix.programId === PUMPSWAP_PROGRAM)!;
    expect(swap).toBeDefined();
    // buy_exact_quote_in: the committed SOL is spent, the slippage-net tokens are the floor.
    expect(swap.data.subarray(0, 8).toString('hex')).toBe('c62e1552b4d9e870');
    expect(swap.data.readBigUInt64LE(8)).toBe(100_000_000n);
    expect(swap.data.readBigUInt64LE(16)).toBe(buy.minOutAmount);
    expect(() => adapter.verify(instructions, buy, pool.user)).not.toThrow();
    const tampered = Buffer.from(swap.data);
    tampered.writeBigUInt64LE(200_000_000n, 8);
    expect(() => adapter.verify(instructions.map((ix) => (ix === swap ? { ...ix, data: tampered } : ix)), buy, pool.user)).toThrow(/SOL budget/);
    const sell = await adapter.quote({ side: 'sell', mint: pool.mint, amountIn: 1_000_000_000n, slippageBps: 50, user: pool.user });
    const sold = decodeInstructions(assembleTransaction(pool.user, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', (await adapter.build(sell, pool.user)).instructions));
    const sellIx = sold.find((ix) => ix.programId === PUMPSWAP_PROGRAM)!;
    expect(sellIx.data.readBigUInt64LE(8)).toBe(1_000_000_000n);
    expect(sellIx.data.readBigUInt64LE(16)).toBe(sell.minOutAmount);
    expect(() => adapter.verify(sold, sell, pool.user)).not.toThrow();
  });

  it('refuses a mint without a canonical pool and a pool quoted in another asset', async () => {
    const missing = new PumpswapAdapter({ rpc, readState: async () => ({ ...pool.state, poolAccountInfo: null }) });
    await expect(missing.quote({ side: 'buy', mint: pool.mint, amountIn: 1n, slippageBps: 100, user: pool.user })).rejects.toMatchObject({ code: 'NOT_ON_CURVE' });
    const usdc = new PumpswapAdapter({ rpc, readState: async () => ({ ...pool.state, pool: { ...pool.state.pool, quoteMint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') } }) });
    await expect(usdc.quote({ side: 'buy', mint: pool.mint, amountIn: 1n, slippageBps: 100, user: pool.user })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    const down = new PumpswapAdapter({ rpc, readState: async () => { throw new Error('rpc down'); } });
    await expect(down.quote({ side: 'buy', mint: pool.mint, amountIn: 1n, slippageBps: 100, user: pool.user })).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE' });
  });
});

describe('MeteoraDbcAdapter', () => {
  const live = fixture<MeteoraDbcState & { poolKey: PublicKey; currentPoint: BN }>('meteora-dbc-pool.json');
  const migrated = fixture<MeteoraDbcState & { poolKey: PublicKey; currentPoint: BN }>('meteora-dbc-pool-migrated.json');
  const stateOf = (f: typeof live): MeteoraDbcState => ({ poolKey: f.state.poolKey.toBase58(), pool: f.state.pool, config: f.state.config, currentPoint: BigInt(f.state.currentPoint.toString()) });
  const swapIx = (pool: string, user: string, amountIn: bigint, minOut: bigint) => {
    const data = Buffer.alloc(24);
    SWAP_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(amountIn, 8);
    data.writeBigUInt64LE(minOut, 16);
    return new TransactionInstruction({ programId: new PublicKey(METEORA_DBC_PROGRAM), keys: [{ pubkey: new PublicKey(pool), isSigner: false, isWritable: true }, { pubkey: new PublicKey(user), isSigner: true, isWritable: true }], data });
  };
  const adapter = new MeteoraDbcAdapter({
    rpc,
    readState: async () => stateOf(live),
    buildSwap: async ({ pool, user, amountIn, minimumAmountOut }) => [swapIx(pool, user, amountIn, minimumAmountOut)],
    now: () => NOW,
  });

  it('quotes a buy on the recorded curve with the Meteora SDK maths, and a sell once the pool holds SOL', async () => {
    const buy = await adapter.quote({ side: 'buy', mint: live.mint, amountIn: 100_000_000n, slippageBps: 100, user: live.user });
    expect(buy).toMatchObject({ venue: 'meteora-dbc', side: 'buy', inAmount: 100_000_000n, quotedAt: NOW });
    expect(buy.outAmount).toBeGreaterThan(0n);
    expect(buy.minOutAmount).toBe((buy.outAmount * 9_900n) / 10_000n);
    expect(buy.venueFeeLamports).toBeGreaterThan(0n);
    // The recorded pool is brand new (no SOL in it yet): a sell is refused as an amount problem, not a crash.
    await expect(adapter.quote({ side: 'sell', mint: live.mint, amountIn: buy.outAmount, slippageBps: 100, user: live.user })).rejects.toMatchObject({ code: 'AMOUNT' });
    // After that buy the pool would hold the SOL and sit at the quote's next price; a sell of the tokens then returns most of it.
    const state = stateOf(live);
    const after = swapQuote(state.pool, state.config, false, new BN('100000000'), 100, false, new BN(state.currentPoint.toString()), false);
    const funded: MeteoraDbcState = {
      ...state,
      pool: { poolState: { ...state.pool.poolState, sqrtPrice: after.nextSqrtPrice, quoteReserve: state.pool.poolState.quoteReserve.add(after.actualInputAmount), baseReserve: state.pool.poolState.baseReserve.sub(after.outputAmount) } },
    };
    const seller = new MeteoraDbcAdapter({ rpc, readState: async () => funded, buildSwap: async () => [], now: () => NOW });
    const sell = await seller.quote({ side: 'sell', mint: live.mint, amountIn: buy.outAmount, slippageBps: 100, user: live.user });
    expect(sell.outAmount).toBeGreaterThan(80_000_000n);
    expect(sell.outAmount).toBeLessThan(100_000_000n);
    expect(sell.minOutAmount).toBe((sell.outAmount * 9_900n) / 10_000n);
  });

  it('builds a swap the verifier accepts and rejects a changed amount, floor or pool', async () => {
    const buy = await adapter.quote({ side: 'buy', mint: live.mint, amountIn: 100_000_000n, slippageBps: 100, user: live.user });
    const built = await adapter.build(buy, live.user);
    const instructions = decodeInstructions(assembleTransaction(live.user, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', built.instructions));
    expect(() => adapter.verify(instructions, buy, live.user)).not.toThrow();
    const other = decodeInstructions(assembleTransaction(live.user, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', [swapIx(live.state.poolKey.toBase58(), live.user, 1n, buy.minOutAmount)]));
    expect(() => adapter.verify(other, buy, live.user)).toThrow(/swap amount/);
    const wrongPool = decodeInstructions(assembleTransaction(live.user, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', [swapIx(migrated.state.poolKey.toBase58(), live.user, buy.inAmount, buy.minOutAmount)]));
    expect(() => adapter.verify(wrongPool, buy, live.user)).toThrow(/pool/);
  });

  it('refuses a migrated pool so the caller can trade it elsewhere', async () => {
    const done = new MeteoraDbcAdapter({ rpc, readState: async () => stateOf(migrated), buildSwap: async () => [] });
    await expect(done.quote({ side: 'buy', mint: migrated.mint, amountIn: 1_000_000n, slippageBps: 100, user: migrated.user })).rejects.toMatchObject({ code: 'MIGRATED' });
  });
});
