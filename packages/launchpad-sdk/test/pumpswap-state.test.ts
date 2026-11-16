/**
 * The PumpSwap state in one RPC round against the vendor's own three-round read, on accounts
 * recorded from mainnet for a classic-Token coin and a Token-2022 coin: the same state, the same quotes, one request,
 * and the vendor's way back for a pool laid out otherwise.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OnlinePumpAmmSdk } from '@pump-fun/pump-swap-sdk';
import { Connection, PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import { PumpswapAdapter, swapStateInOneRead } from '../src/pumpswap';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type SolanaRpc } from '../src/solana';

interface Recorded {
  mint: string;
  user: string;
  pool: string;
  accounts: Record<string, { lamports: number; owner: string; executable: boolean; rentEpoch: number; data: string } | null>;
}

/** A recorded account set served as the node serves it: in request order, null where the chain had none. */
function recorded(name: string, change: (key: string, info: AccountInfo<Buffer> | null) => AccountInfo<Buffer> | null = (_, info) => info) {
  const raw = JSON.parse(readFileSync(join(__dirname, '../src/__fixtures__', name), 'utf8')) as Recorded;
  const infos = new Map<string, AccountInfo<Buffer> | null>(
    Object.entries(raw.accounts).map(([key, a]) => [key, change(key, a ? { lamports: a.lamports, owner: new PublicKey(a.owner), executable: a.executable, rentEpoch: a.rentEpoch, data: Buffer.from(a.data, 'base64') } : null)]),
  );
  const calls: string[][] = [];
  const read = async (keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> => {
    calls.push(keys.map((k) => k.toBase58()));
    return keys.map((k) => {
      const key = k.toBase58();
      if (!infos.has(key)) throw new Error(`not recorded: ${key}`);
      return infos.get(key)!;
    });
  };
  return { mint: new PublicKey(raw.mint), user: new PublicKey(raw.user), pool: new PublicKey(raw.pool), read, calls };
}

/** The vendor's read over the same accounts. */
async function vendorState(set: ReturnType<typeof recorded>) {
  const connection = new Connection('https://rpc.invalid');
  Object.assign(connection, { getMultipleAccountsInfo: set.read });
  return new OnlinePumpAmmSdk(connection).swapSolanaState(set.pool, set.user);
}

/** Comparable form: keys as base58, numbers as strings, bytes as base64 (the vendor's objects may come from another copy of web3). */
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'bigint') return `${value}n`;
  if (BN.isBN(value)) return (value as BN).toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value === 'object' && typeof (value as { toBase58?: unknown }).toBase58 === 'function') return (value as PublicKey).toBase58();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)]));
  return value;
}

const rpc = { url: 'https://rpc.invalid' } as unknown as SolanaRpc;

describe.each([
  ['classic Token', 'pumpswap-accounts-token.json', TOKEN_PROGRAM],
  ['Token-2022', 'pumpswap-accounts-token2022.json', TOKEN_2022_PROGRAM],
])('PumpSwap state in one read: %s coin', (_, file, program) => {
  it('builds the vendor state with one request where the vendor makes three', async () => {
    const mine = recorded(file);
    const state = await swapStateInOneRead(mine.read, mine.pool, mine.mint, mine.user);
    expect(mine.calls).toHaveLength(1);
    expect(mine.calls[0]).toHaveLength(11);
    const theirs = recorded(file);
    const vendor = await vendorState(theirs);
    expect(theirs.calls).toHaveLength(3);
    expect(state).not.toBeNull();
    expect(state!.baseTokenProgram.toBase58()).toBe(program);
    expect(plain(state)).toEqual(plain(vendor));
  });

  it('quotes a buy and a sell exactly as from the vendor state', async () => {
    const set = recorded(file);
    const state = (await swapStateInOneRead(set.read, set.pool, set.mint, set.user))!;
    const vendor = await vendorState(recorded(file));
    const ours = new PumpswapAdapter({ rpc, readState: async () => state, now: () => 1 });
    const theirs = new PumpswapAdapter({ rpc, readState: async () => vendor, now: () => 1 });
    const buy = { side: 'buy' as const, mint: set.mint.toBase58(), amountIn: 10_000_000n, slippageBps: 500, user: set.user.toBase58() };
    const a = await ours.quote(buy);
    const b = await theirs.quote(buy);
    expect([a.outAmount, a.minOutAmount, a.venueFeeLamports, a.priceImpactBps]).toEqual([b.outAmount, b.minOutAmount, b.venueFeeLamports, b.priceImpactBps]);
    const sell = { ...buy, side: 'sell' as const, amountIn: a.outAmount };
    const c = await ours.quote(sell);
    const d = await theirs.quote(sell);
    expect([c.outAmount, c.minOutAmount, c.venueFeeLamports]).toEqual([d.outAmount, d.minOutAmount, d.venueFeeLamports]);
    expect(c.outAmount).toBeGreaterThan(0n);
  });
});

describe('PumpSwap state in one read: the vendor way back', () => {
  it('is null for a pool whose vaults are not the derived accounts, so the caller reads it the vendor way', async () => {
    // The mint's owner flipped to the other token program: the derived vault is then not the pool's own.
    const set = recorded('pumpswap-accounts-token.json', (key, info) => (key === 'CscZaq5twomhUkvCY8Jdd1tge32L4Yj9FbkFFEZQpump' && info ? { ...info, owner: new PublicKey(TOKEN_2022_PROGRAM) } : info));
    expect(await swapStateInOneRead(set.read, set.pool, set.mint, set.user)).toBeNull();
  });

  it('is null for a pool of another mint', async () => {
    const set = recorded('pumpswap-accounts-token2022.json');
    // The recorded pool asked for under the classic coin's mint: accounts never recorded answer as absent.
    const other = new PublicKey('CscZaq5twomhUkvCY8Jdd1tge32L4Yj9FbkFFEZQpump');
    const read = (keys: PublicKey[]) => Promise.all(keys.map(async (key) => (await set.read([key]).catch(() => [null]))[0] ?? null));
    expect(await swapStateInOneRead(read, set.pool, other, set.user)).toBeNull();
  });

  it('refuses a missing pool in the vendor words', async () => {
    const plainSet = recorded('pumpswap-accounts-token2022.json');
    const pool = plainSet.pool.toBase58();
    const missing = recorded('pumpswap-accounts-token2022.json', (key, info) => (key === pool ? null : info));
    await expect(swapStateInOneRead(missing.read, missing.pool, missing.mint, missing.user)).rejects.toThrow('Pool account not found');
  });

  it('hands the adapter state reader the mint it quotes', async () => {
    const set = recorded('pumpswap-accounts-token2022.json');
    const state = (await swapStateInOneRead(set.read, set.pool, set.mint, set.user))!;
    const asked: string[] = [];
    const adapter = new PumpswapAdapter({
      rpc,
      readState: async (poolKey, user, mint) => {
        asked.push(poolKey, user, mint);
        return state;
      },
    });
    await adapter.quote({ side: 'buy', mint: set.mint.toBase58(), amountIn: 1_000_000n, slippageBps: 100, user: set.user.toBase58() });
    expect(asked).toEqual([set.pool.toBase58(), set.user.toBase58(), set.mint.toBase58()]);
  });
});
