/**
 * The SDK against mainnet. Opt-in with `LIVE=1`; it reads the chain and asks
 * the node to simulate. Nothing is signed and nothing is sent.
 *
 *   LIVE=1 pnpm --filter @soltoolkit/launchpad-sdk test:live
 *
 * A simulation only runs the programs when the paying wallet exists and holds
 * SOL, so the buys are simulated for a funded wallet picked from the latest
 * pump.fun transactions (or `LIVE_WALLET`). Signature checks are off: no key
 * of that wallet is involved and the transaction could not land.
 *
 * Environment:
 *   SOLANA_RPC_URL          any mainnet JSON-RPC endpoint (default: the public one, which throttles)
 *   LIVE_WALLET             the wallet to simulate for (default: found on chain)
 *   PUMPFUN_LIVE_MINT       a token still on its pump.fun curve (default: found on chain)
 *   PUMPSWAP_LIVE_MINT      a pump.fun graduate on PumpSwap (default below)
 *   METEORA_DBC_LIVE_MINT   a SOL-quoted token on a Meteora DBC curve (default: found on chain)
 *   METEORA_DBC_LIVE_POOL   its pool (default: found on chain)
 */

import { OnlinePumpAmmSdk } from '@pump-fun/pump-swap-sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { LaunchpadError, METEORA_DBC_PROGRAM, PUMPFUN_PROGRAM, PumpswapAdapter, SolanaRpc, WSOL_MINT, computeBudgetOf, createLaunchpads, decodeInstructions, swapStateInOneRead, type LaunchpadQuoteRequest, type Launchpads, type Venue } from '../../src/index';

const LIVE = process.env['LIVE'] === '1';
const RPC_URL = process.env['SOLANA_RPC_URL']?.trim() || 'https://api.mainnet-beta.solana.com';
const WALLET = process.env['LIVE_WALLET']?.trim() ?? '';
const PUMPFUN_MINT = process.env['PUMPFUN_LIVE_MINT']?.trim() ?? '';
// A Token-2022 pump.fun graduate on its canonical PumpSwap pool.
const PUMPSWAP_MINT = process.env['PUMPSWAP_LIVE_MINT']?.trim() || 'Q2XHaRR82k2Ak2LtM9uEYEE7K9NWB2vyeCFTpRRpump';
const DBC_MINT = process.env['METEORA_DBC_LIVE_MINT']?.trim() ?? '';
const DBC_POOL = process.env['METEORA_DBC_LIVE_POOL']?.trim() ?? '';
const AMOUNT = 10_000_000n; // 0.01 SOL
/** Enough for the buy, the token account rent and the fees. */
const MIN_WALLET_LAMPORTS = 100_000_000n;

interface SignatureInfo {
  readonly signature: string;
  readonly err: unknown;
}
interface TransactionInfo {
  readonly transaction: { readonly message: { readonly accountKeys: readonly { readonly pubkey: string; readonly signer: boolean }[] } };
  readonly meta: { readonly postTokenBalances?: readonly { readonly mint: string }[] } | null;
}

/**
 * From the latest pump.fun transactions: a wallet that holds SOL, and a token
 * that still quotes on its curve. Either can be given by the environment.
 */
async function findOnChain(launchpads: Launchpads): Promise<{ wallet: string; curveMint: string }> {
  let wallet = WALLET;
  let curveMint = PUMPFUN_MINT;
  const signatures = await launchpads.rpc.call<SignatureInfo[]>('getSignaturesForAddress', [PUMPFUN_PROGRAM, { limit: 40 }]);
  const seen = new Set<string>();
  for (const { signature, err } of signatures) {
    if (wallet && curveMint) break;
    if (err) continue;
    const tx = await launchpads.rpc.call<TransactionInfo | null>('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    if (!tx) continue;
    const payer = tx.transaction.message.accountKeys[0]?.pubkey;
    if (!wallet && payer && !seen.has(payer)) {
      seen.add(payer);
      if ((await launchpads.rpc.getBalance(payer)) >= MIN_WALLET_LAMPORTS) wallet = payer;
    }
    for (const { mint } of tx.meta?.postTokenBalances ?? []) {
      if (curveMint || !mint.endsWith('pump') || seen.has(mint)) continue;
      seen.add(mint);
      try {
        await launchpads.quote({ side: 'buy', mint, amountIn: AMOUNT, slippageBps: 500, user: payer ?? mint }, 'pumpfun');
        curveMint = mint;
      } catch (error) {
        if (!(error instanceof LaunchpadError)) throw error;
      }
    }
  }
  if (!wallet) throw new Error('no funded wallet in the latest pump.fun transactions; set LIVE_WALLET');
  if (!curveMint) throw new Error('no token on its curve in the latest pump.fun transactions; set PUMPFUN_LIVE_MINT');
  return { wallet, curveMint };
}

/**
 * A token on a Meteora DBC curve that is quoted in SOL, with its pool, from
 * the program's latest transactions. The pool is the program-owned account of
 * the transaction that carries the mint, so no program scan is needed.
 */
async function findDbcOnChain(launchpads: Launchpads, user: string): Promise<{ mint: string; pool: string }> {
  if (DBC_MINT && DBC_POOL) return { mint: DBC_MINT, pool: DBC_POOL };
  const signatures = await launchpads.rpc.call<SignatureInfo[]>('getSignaturesForAddress', [METEORA_DBC_PROGRAM, { limit: 40 }]);
  const seen = new Set<string>();
  for (const { signature, err } of signatures) {
    if (err) continue;
    const tx = await launchpads.rpc.call<TransactionInfo | null>('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    if (!tx) continue;
    const mints = [...new Set((tx.meta?.postTokenBalances ?? []).map((b) => b.mint))].filter((m) => m !== WSOL_MINT && !seen.has(m) && (!DBC_MINT || m === DBC_MINT));
    if (mints.length === 0) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey).slice(0, 100);
    const accounts = await launchpads.rpc.getMultipleAccounts(keys);
    for (const mint of mints) {
      seen.add(mint);
      const bytes = new PublicKey(mint).toBuffer();
      for (const [i, account] of accounts.entries()) {
        if (!account || account.owner !== METEORA_DBC_PROGRAM || account.data.indexOf(bytes) < 0) continue;
        const pool = keys[i]!;
        try {
          await launchpads.quote({ side: 'buy', mint, amountIn: AMOUNT, slippageBps: 500, user, pool }, 'meteora-dbc');
          return { mint, pool };
        } catch (error) {
          if (!(error instanceof LaunchpadError)) throw error;
        }
      }
    }
  }
  throw new Error('no SOL-quoted token on a Meteora DBC curve in the latest transactions; set METEORA_DBC_LIVE_MINT and METEORA_DBC_LIVE_POOL');
}

describe.skipIf(!LIVE)('launchpads live', () => {
  const launchpads = createLaunchpads({ rpcUrl: RPC_URL });
  let wallet = '';
  let curveMint = '';

  beforeAll(async () => {
    ({ wallet, curveMint } = await findOnChain(launchpads));
    console.log('[live] wallet', wallet, 'curve token', curveMint);
  });

  /**
   * Quote, build, verify and simulate. The programs must run to the end: a
   * failure means the instructions are wrong for the program as it is
   * deployed today. A pool can move past the slippage between the quote and
   * the simulation, so a failed attempt is quoted again, twice at most.
   */
  async function simulates(request: LaunchpadQuoteRequest, venue: Venue | undefined, label: string): Promise<void> {
    let last = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const quote = await launchpads.quote(request, venue);
      const built = await launchpads.buildTransaction(quote, request.user, { priorityFeeLamports: 100_000n });
      launchpads.verifyTransaction(built.base64, quote, request.user);
      const simulation = await launchpads.rpc.simulateTransaction(built.base64, { sigVerify: false });
      const limit = computeBudgetOf(decodeInstructions(built.transaction)).units;
      console.log(`[${label}] attempt ${attempt}: err ${JSON.stringify(simulation.err)}, compute units ${simulation.unitsConsumed} of ${limit}`);
      if (!simulation.err) {
        expect(simulation.unitsConsumed).not.toBeNull();
        expect(simulation.unitsConsumed!).toBeLessThanOrEqual(limit!);
        return;
      }
      last = `${JSON.stringify(simulation.err)}\n${simulation.logs.slice(-8).join('\n')}`;
    }
    throw new Error(`${label}: the simulation failed three times\n${last}`);
  }

  it(
    'pump.fun: quotes a token on its curve, and its buy runs to the end in simulation',
    async () => {
      const request = { side: 'buy' as const, mint: curveMint, amountIn: AMOUNT, slippageBps: 500, user: wallet };
      const buy = await launchpads.quote(request);
      console.log('[pumpfun] buy', AMOUNT.toString(), 'lamports ->', buy.outAmount.toString(), 'tokens; venue fee', buy.venueFeeLamports.toString(), 'impact bps', buy.priceImpactBps);
      expect(buy.venue).toBe('pumpfun');
      expect(buy.outAmount).toBeGreaterThan(0n);
      expect(buy.minOutAmount).toBeLessThanOrEqual(buy.outAmount);
      await simulates(request, undefined, 'pumpfun buy');
      // Selling back what the buy would give returns less than was paid: fees on both legs. The wallet does not hold
      // the token, so the sell is built and verified but not simulated.
      const sell = await launchpads.quote({ ...request, side: 'sell', amountIn: buy.outAmount }, 'pumpfun');
      console.log('[pumpfun] sell', buy.outAmount.toString(), 'tokens ->', sell.outAmount.toString(), 'lamports');
      expect(sell.outAmount).toBeGreaterThan(0n);
      expect(sell.outAmount).toBeLessThan(AMOUNT);
      await launchpads.buildTransaction(sell, wallet);
    },
    120_000,
  );

  it(
    'PumpSwap: a graduate is found without naming the venue, and its buy runs to the end in simulation',
    async () => {
      const request = { side: 'buy' as const, mint: PUMPSWAP_MINT, amountIn: AMOUNT, slippageBps: 500, user: wallet };
      const quote = await launchpads.quote(request);
      console.log('[pumpswap]', PUMPSWAP_MINT, 'buy', AMOUNT.toString(), 'lamports ->', quote.outAmount.toString(), 'tokens; venue fee', quote.venueFeeLamports.toString());
      expect(quote.venue).toBe('pumpswap');
      expect(quote.outAmount).toBeGreaterThan(0n);
      await simulates(request, undefined, 'pumpswap buy');
    },
    120_000,
  );

  it(
    'PumpSwap: the one-read state has the same accounts as the three-read state of the PumpSwap SDK, and quotes the same',
    async () => {
      const connection = new Connection(RPC_URL, 'confirmed');
      const mint = new PublicKey(PUMPSWAP_MINT);
      const user = new PublicKey(wallet);
      const pool = new PublicKey(PumpswapAdapter.canonicalPool(PUMPSWAP_MINT));
      let requests = 0;
      const mine = await swapStateInOneRead(
        (keys) => {
          requests += 1;
          return connection.getMultipleAccountsInfo(keys);
        },
        pool,
        mint,
        user,
      );
      const theirs = await new OnlinePumpAmmSdk(connection).swapSolanaState(pool, user);
      expect(requests).toBe(1);
      expect(mine).not.toBeNull();
      for (const key of ['poolKey', 'baseTokenProgram', 'quoteTokenProgram', 'baseMint', 'userBaseTokenAccount', 'userQuoteTokenAccount'] as const) {
        expect(mine![key].toBase58(), key).toBe(theirs[key].toBase58());
      }
      // The pool may trade between the two reads, so the quotes agree within 1 %, not to the unit.
      const rpc = new SolanaRpc({ url: RPC_URL });
      const request = { side: 'buy' as const, mint: PUMPSWAP_MINT, amountIn: AMOUNT, slippageBps: 500, user: wallet };
      const a = await new PumpswapAdapter({ rpc, readState: async () => mine! }).quote(request);
      const b = await new PumpswapAdapter({ rpc, readState: async () => theirs }).quote(request);
      const diff = Number(((a.outAmount > b.outAmount ? a.outAmount - b.outAmount : b.outAmount - a.outAmount) * 10_000n) / b.outAmount) / 100;
      console.log('[pumpswap] one read', a.outAmount.toString(), 'against', b.outAmount.toString(), `(${diff.toFixed(3)} %)`);
      expect(diff).toBeLessThanOrEqual(1);
    },
    120_000,
  );

  it(
    'Meteora DBC: quotes a token on its curve, and its buy runs to the end in simulation',
    async () => {
      const { mint, pool } = await findDbcOnChain(launchpads, wallet);
      const request = { side: 'buy' as const, mint, amountIn: AMOUNT, slippageBps: 500, user: wallet, pool };
      const quote = await launchpads.quote(request, 'meteora-dbc');
      console.log('[meteora-dbc]', mint, 'pool', pool, 'buy', AMOUNT.toString(), 'lamports ->', quote.outAmount.toString(), 'tokens');
      expect(quote.outAmount).toBeGreaterThan(0n);
      await simulates(request, 'meteora-dbc', 'meteora-dbc buy');
    },
    120_000,
  );

  it(
    'a real token with no curve and no pool is answered "not here"; a mint that does not exist is not',
    async () => {
      // USDC: a real mint that was never a pump.fun token.
      const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const request = { side: 'buy' as const, mint: usdc, amountIn: AMOUNT, slippageBps: 500, user: wallet };
      await expect(launchpads.quote(request, 'pumpfun')).rejects.toMatchObject({ code: 'NOT_ON_CURVE' });
      await expect(launchpads.quote(request, 'pumpswap')).rejects.toMatchObject({ code: 'NOT_ON_CURVE' });
      // An address nothing lives at is a failed read, never "not listed": the search stops there.
      const nowhere = Keypair.generate().publicKey.toBase58();
      await expect(launchpads.quote({ ...request, mint: nowhere })).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE' });
    },
    120_000,
  );
});
