/**
 * Shared by the unit tests: the recorded pump.fun curve and an RPC that
 * answers from it, so nothing here touches the network.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_PROGRAM, type RpcAccount, type SolanaRpc } from '../src/solana';

export interface CurveFixture {
  mint: string;
  slot: number;
  pdas: { global: string; feeConfig: string; bondingCurve: string };
  supply: { amount: string; decimals: number };
  accounts: Record<string, { data: string; owner: string; lamports: number } | null>;
}

export const FIXTURES = join(__dirname, '../src/__fixtures__');

export function curveFixture(name: string): CurveFixture {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as CurveFixture;
}

/** A pump.fun curve recorded from mainnet at slot 449288597, still trading on the curve. */
export const CURVE = curveFixture('pumpfun-curve.json');
/** A wallet with no token accounts in any fixture. */
export const USER = 'Em9VYusJCMEydDjFhNEvoN34hnHK6W9UPXEtNBxfWB9E';
export const NOW = 1_790_000_000_000;
export const BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';

/** An RPC that answers from the fixture; the mint is a classic SPL mint and the user holds no token account. */
export function fixtureRpc(fixture: CurveFixture, extra: Record<string, RpcAccount | null> = {}): SolanaRpc {
  const accounts = new Map<string, RpcAccount | null>();
  for (const [address, account] of Object.entries(fixture.accounts)) {
    accounts.set(address, account ? { data: Buffer.from(account.data, 'base64'), owner: account.owner, lamports: account.lamports } : null);
  }
  accounts.set(fixture.mint, { data: Buffer.alloc(82), owner: TOKEN_PROGRAM, lamports: 1_461_600 });
  for (const [address, account] of Object.entries(extra)) accounts.set(address, account);
  return {
    url: 'https://rpc.invalid',
    async getAccount(address: string) {
      return accounts.get(address) ?? null;
    },
    async getMultipleAccounts(addresses: readonly string[]) {
      return addresses.map((a) => accounts.get(a) ?? null);
    },
    async getTokenSupply() {
      return { amount: BigInt(fixture.supply.amount), decimals: fixture.supply.decimals };
    },
    async getLatestBlockhash() {
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 300_000_000 };
    },
  } as unknown as SolanaRpc;
}
