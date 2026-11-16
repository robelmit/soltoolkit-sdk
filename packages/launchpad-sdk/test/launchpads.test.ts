/**
 * The entry point: which venue answers, the unsigned transaction it returns,
 * and what `verifyTransaction` refuses when the bytes are not the quoted swap.
 */

import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { NoVenueError, VENUE_ORDER, createLaunchpads } from '../src/launchpads';
import { COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, assembleTransaction, computeBudgetInstructions, computeBudgetOf, decodeInstructions, encodeTransaction } from '../src/solana';
import { PUMPFUN_PROGRAM } from '../src/pumpfun';
import { LaunchpadError, type LaunchpadAdapter, type LaunchpadQuote, type Venue } from '../src/types';
import { BLOCKHASH, CURVE, USER, fixtureRpc } from './helpers';

const STRANGER = 'So11111111111111111111111111111111111111112';

/** An adapter that always answers the same way. */
function stub(venue: Venue, answer: LaunchpadError | LaunchpadQuote): LaunchpadAdapter & { calls: number } {
  const adapter = {
    venue,
    programs: [],
    calls: 0,
    async quote() {
      adapter.calls += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async build() {
      return { instructions: [], computeUnits: 1 };
    },
    verify() {},
  };
  return adapter;
}

const quoteOn = (venue: Venue): LaunchpadQuote => ({ venue, side: 'buy', mint: CURVE.mint, inAmount: 1n, outAmount: 1n, minOutAmount: 1n, slippageBps: 0, venueFeeLamports: 0n, priceImpactBps: null, state: null, quotedAt: 0 });
const notHere = (venue: Venue) => new LaunchpadError(venue, 'NOT_ON_CURVE', 'no pool');
const request = { side: 'buy' as const, mint: CURVE.mint, amountIn: 10_000_000n, slippageBps: 100, user: USER };

describe('createLaunchpads', () => {
  it('needs an RPC', () => {
    expect(() => createLaunchpads({})).toThrow(/rpcUrl or rpc/);
    expect(createLaunchpads({ rpcUrl: 'https://rpc.invalid' }).rpc.url).toBe('https://rpc.invalid');
  });

  it('looks for a token in the order of its life', () => {
    expect(VENUE_ORDER).toEqual(['pumpfun', 'pumpswap', 'meteora-dbc']);
  });
});

describe('quote', () => {
  it('answers from the first venue that has the token and asks no further', async () => {
    const pumpswap = stub('pumpswap', quoteOn('pumpswap'));
    const launchpads = createLaunchpads({ rpc: fixtureRpc(CURVE), adapters: { pumpswap } });
    const quote = await launchpads.quote(request);
    expect(quote.venue).toBe('pumpfun');
    expect(quote.outAmount).toBeGreaterThan(0n);
    expect(pumpswap.calls).toBe(0);
  });

  it('moves on when a curve has completed or the token was never there', async () => {
    const migrated = stub('pumpfun', new LaunchpadError('pumpfun', 'MIGRATED', 'curve complete'));
    const amm = stub('pumpswap', quoteOn('pumpswap'));
    expect((await createLaunchpads({ rpcUrl: 'https://rpc.invalid', adapters: { pumpfun: migrated, pumpswap: amm } }).quote(request)).venue).toBe('pumpswap');
    const dbc = stub('meteora-dbc', quoteOn('meteora-dbc'));
    const launchpads = createLaunchpads({ rpcUrl: 'https://rpc.invalid', adapters: { pumpfun: stub('pumpfun', notHere('pumpfun')), pumpswap: stub('pumpswap', notHere('pumpswap')), 'meteora-dbc': dbc } });
    expect((await launchpads.quote(request)).venue).toBe('meteora-dbc');
  });

  it('says so when no venue has the token, with what each one answered', async () => {
    const launchpads = createLaunchpads({
      rpcUrl: 'https://rpc.invalid',
      adapters: { pumpfun: stub('pumpfun', new LaunchpadError('pumpfun', 'MIGRATED', 'curve complete')), pumpswap: stub('pumpswap', notHere('pumpswap')), 'meteora-dbc': stub('meteora-dbc', notHere('meteora-dbc')) },
    });
    const error = await launchpads.quote(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoVenueError);
    expect((error as NoVenueError).attempts.map((a) => [a.venue, a.code])).toEqual([
      ['pumpfun', 'MIGRATED'],
      ['pumpswap', 'NOT_ON_CURVE'],
      ['meteora-dbc', 'NOT_ON_CURVE'],
    ]);
  });

  it('never reads a failed state read as "not listed"', async () => {
    const amm = stub('pumpswap', quoteOn('pumpswap'));
    const launchpads = createLaunchpads({ rpcUrl: 'https://rpc.invalid', adapters: { pumpfun: stub('pumpfun', new LaunchpadError('pumpfun', 'STATE_UNAVAILABLE', 'rpc down')), pumpswap: amm } });
    await expect(launchpads.quote(request)).rejects.toMatchObject({ code: 'STATE_UNAVAILABLE' });
    expect(amm.calls).toBe(0);
  });

  it('asks only the venue that is named', async () => {
    const pumpfun = stub('pumpfun', quoteOn('pumpfun'));
    const launchpads = createLaunchpads({ rpcUrl: 'https://rpc.invalid', adapters: { pumpfun, pumpswap: stub('pumpswap', notHere('pumpswap')) } });
    await expect(launchpads.quote(request, 'pumpswap')).rejects.toMatchObject({ code: 'NOT_ON_CURVE' });
    expect(pumpfun.calls).toBe(0);
  });
});

describe('buildTransaction and verifyTransaction', () => {
  const launchpads = createLaunchpads({ rpc: fixtureRpc(CURVE) });
  const adapter = launchpads.adapter('pumpfun');

  /** The swap instructions for the quote, to rebuild a transaction around with something changed. */
  async function parts() {
    const quote = await launchpads.quote(request, 'pumpfun');
    const { instructions, computeUnits } = await adapter.build(quote, USER);
    return { quote, swap: [...instructions], budget: computeBudgetInstructions(computeUnits, 0n) };
  }

  it('returns an unsigned transaction: the compute budget, then the swap, paid by the wallet', async () => {
    const quote = await launchpads.quote(request);
    const built = await launchpads.buildTransaction(quote, USER, { priorityFeeLamports: 100_000n });
    expect(built.recentBlockhash).toBe(BLOCKHASH);
    expect(built.lastValidBlockHeight).toBe(300_000_000);
    expect(built.transaction.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    expect(built.transaction.message.staticAccountKeys[0]!.toBase58()).toBe(USER);
    const instructions = decodeInstructions(built.transaction);
    expect(instructions.map((ix) => ix.programId)).toEqual([COMPUTE_BUDGET_PROGRAM, COMPUTE_BUDGET_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, PUMPFUN_PROGRAM]);
    const budget = computeBudgetOf(instructions);
    expect(budget.units).toBe(built.computeUnits);
    expect(budget.priorityFeeLamports).toBeGreaterThanOrEqual(100_000n);
    expect(budget.priorityFeeLamports).toBeLessThanOrEqual(100_002n);
    // The same answer for the object, its bytes and its base64.
    expect(() => launchpads.verifyTransaction(built.transaction, quote, USER)).not.toThrow();
    expect(() => launchpads.verifyTransaction(built.transaction.serialize(), quote, USER)).not.toThrow();
    expect(() => launchpads.verifyTransaction(built.base64, quote, USER)).not.toThrow();
    expect(VersionedTransaction.deserialize(Buffer.from(built.base64, 'base64')).message.recentBlockhash).toBe(BLOCKHASH);
  });

  it('uses the blockhash and compute units it is given', async () => {
    const quote = await launchpads.quote(request);
    const other = 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W';
    const built = await launchpads.buildTransaction(quote, USER, { recentBlockhash: other, computeUnits: 400_000 });
    expect(built.recentBlockhash).toBe(other);
    expect(built.lastValidBlockHeight).toBeNull();
    expect(computeBudgetOf(decodeInstructions(built.transaction)).units).toBe(400_000);
  });

  it('refuses a transaction for another quote', async () => {
    const quote = await launchpads.quote(request);
    const built = await launchpads.buildTransaction(quote, USER);
    expect(() => launchpads.verifyTransaction(built.base64, { ...quote, inAmount: quote.inAmount + 1n }, USER)).toThrow(/SOL budget/);
    expect(() => launchpads.verifyTransaction(built.base64, { ...quote, minOutAmount: quote.minOutAmount - 1n }, USER)).toThrow(/token floor/);
    expect(() => launchpads.verifyTransaction(built.base64, quote, STRANGER)).toThrow(/fee payer/);
  });

  it('refuses a lamport transfer riding along with the swap', async () => {
    const { quote, swap, budget } = await parts();
    const drain = SystemProgram.transfer({ fromPubkey: new PublicKey(USER), toPubkey: new PublicKey(STRANGER), lamports: 1_000_000_000 });
    const tx = assembleTransaction(USER, BLOCKHASH, [...budget, ...swap, drain]);
    expect(() => launchpads.verifyTransaction(encodeTransaction(tx), quote, USER)).toThrow(/unexpected instruction/);
  });

  it('refuses a second swap', async () => {
    const { quote, swap, budget } = await parts();
    const tx = assembleTransaction(USER, BLOCKHASH, [...budget, ...swap, swap[swap.length - 1]!]);
    expect(() => launchpads.verifyTransaction(encodeTransaction(tx), quote, USER)).toThrow(/one pump.fun instruction/);
  });

  it('refuses a fee payer or a second signer that is not the wallet', async () => {
    const { quote, swap, budget } = await parts();
    const paidByAnother = assembleTransaction(STRANGER, BLOCKHASH, [...budget, ...swap]);
    expect(() => launchpads.verifyTransaction(paidByAnother, quote, USER)).toThrow(/signatures|fee payer/);
    const cosigned = new TransactionInstruction({ programId: new PublicKey(PUMPFUN_PROGRAM), keys: [{ pubkey: new PublicKey(STRANGER), isSigner: true, isWritable: false }], data: Buffer.alloc(0) });
    const tx = assembleTransaction(USER, BLOCKHASH, [...budget, ...swap, cosigned]);
    expect(() => launchpads.verifyTransaction(tx, quote, USER)).toThrow(/2 signatures/);
  });

  it('refuses a priority fee above the limit, and one that cannot be bounded', async () => {
    const quote = await launchpads.quote(request);
    const costly = await launchpads.buildTransaction(quote, USER, { priorityFeeLamports: 20_000_000n });
    expect(() => launchpads.verifyTransaction(costly.base64, quote, USER)).toThrow(/priority fee .* above the limit/);
    expect(() => launchpads.verifyTransaction(costly.base64, quote, USER, { maxPriorityFeeLamports: 20_000_002n })).not.toThrow();
    const { swap } = await parts();
    const priceOnly = assembleTransaction(USER, BLOCKHASH, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000_000 }), ...swap]);
    expect(() => launchpads.verifyTransaction(priceOnly, quote, USER)).toThrow(/without a compute unit limit/);
    const twice = assembleTransaction(USER, BLOCKHASH, [...computeBudgetInstructions(200_000, 1_000n), ...computeBudgetInstructions(200_000, 1_000n), ...swap]);
    expect(() => launchpads.verifyTransaction(twice, quote, USER)).toThrow(/more than once/);
    const heap = assembleTransaction(USER, BLOCKHASH, [ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }), ...swap]);
    expect(() => launchpads.verifyTransaction(heap, quote, USER)).toThrow(/unexpected compute budget/);
  });

  it('refuses a transaction whose accounts hide behind a lookup table', async () => {
    const { quote, swap, budget } = await parts();
    const table = new AddressLookupTableAccount({
      key: new PublicKey('GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W'),
      state: { deactivationSlot: 18_446_744_073_709_551_615n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [new PublicKey(CURVE.mint)] },
    });
    const message = new TransactionMessage({ payerKey: new PublicKey(USER), recentBlockhash: BLOCKHASH, instructions: [...budget, ...swap] }).compileToV0Message([table]);
    expect(message.addressTableLookups.length).toBe(1);
    expect(() => launchpads.verifyTransaction(new VersionedTransaction(message), quote, USER)).toThrow(/lookup-table/);
  });
});
