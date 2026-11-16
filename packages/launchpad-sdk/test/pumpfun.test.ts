/**
 * The pump.fun adapter against a recorded curve (slot 449288597): quotes with
 * the SDK's maths, builds the SDK's instruction, and re-reads it before
 * signing. The check against mainnet is in `live/pumpfun.live.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { PumpfunAdapter, PUMPFUN_PROGRAM } from '../src/pumpfun';
import { LaunchpadError } from '../src/types';
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM, assembleTransaction, associatedTokenAddress, decodeInstructions } from '../src/solana';
import { CURVE, NOW, USER, curveFixture, fixtureRpc } from './helpers';

describe('PumpfunAdapter', () => {
  const adapter = new PumpfunAdapter({ rpc: fixtureRpc(CURVE), now: () => NOW });

  it('quotes a buy from the recorded curve with the venue SDK maths and a budgeted floor', async () => {
    const quote = await adapter.quote({ side: 'buy', mint: CURVE.mint, amountIn: 10_000_000n, slippageBps: 100, user: USER });
    expect(quote.venue).toBe('pumpfun');
    expect(quote.inAmount).toBe(10_000_000n);
    expect(quote.outAmount).toBeGreaterThan(0n);
    expect(quote.minOutAmount).toBe((quote.outAmount * 9_900n) / 10_000n);
    // A fresh curve: ~30.1 SOL of virtual quote against ~1.07B tokens, so 0.01 SOL buys about 350k tokens.
    const tokens = Number(quote.outAmount) / 1e6;
    expect(tokens).toBeGreaterThan(300_000);
    expect(tokens).toBeLessThan(400_000);
    // Protocol + creator fee on 0.01 SOL at this market cap: between 0.5 % and 2 %.
    expect(quote.venueFeeLamports).toBeGreaterThanOrEqual(50_000n);
    expect(quote.venueFeeLamports).toBeLessThanOrEqual(200_000n);
    expect(quote.priceImpactBps).toBeGreaterThan(0);
    expect(quote.priceImpactBps).toBeLessThan(50);
    expect(quote.quotedAt).toBe(NOW);
  });

  it('quotes a sell as SOL out net of the venue fee, with the floor under the allowance', async () => {
    const buy = await adapter.quote({ side: 'buy', mint: CURVE.mint, amountIn: 10_000_000n, slippageBps: 100, user: USER });
    const sell = await adapter.quote({ side: 'sell', mint: CURVE.mint, amountIn: buy.outAmount, slippageBps: 100, user: USER });
    expect(sell.side).toBe('sell');
    // Selling what 0.01 SOL just bought returns a little under 0.01 SOL: two fees and the spread.
    expect(sell.outAmount).toBeLessThan(10_000_000n);
    expect(sell.outAmount).toBeGreaterThan(9_500_000n);
    expect(sell.minOutAmount).toBe((sell.outAmount * 9_900n) / 10_000n);
  });

  it('builds the wallet token account and the venue SDK buy instruction, then verifies its own bytes', async () => {
    const quote = await adapter.quote({ side: 'buy', mint: CURVE.mint, amountIn: 10_000_000n, slippageBps: 100, user: USER });
    const built = await adapter.build(quote, USER);
    const tx = assembleTransaction(USER, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', built.instructions);
    const instructions = decodeInstructions(tx);
    expect(instructions.map((ix) => ix.programId)).toEqual([ASSOCIATED_TOKEN_PROGRAM, PUMPFUN_PROGRAM]);
    expect(instructions[0]!.accounts[1]).toBe(associatedTokenAddress(USER, CURVE.mint, TOKEN_PROGRAM));
    const buy = instructions[1]!;
    // buy_exact_sol_in: the committed SOL is spent, the slippage-net tokens are the floor.
    expect(buy.data.subarray(0, 8).toString('hex')).toBe('38fc74089edfcd5f');
    expect(buy.data.readBigUInt64LE(8)).toBe(10_000_000n);
    expect(buy.data.readBigUInt64LE(16)).toBe(quote.minOutAmount);
    expect(() => adapter.verify(instructions, quote, USER)).not.toThrow();
    // A tampered budget, floor or mint is caught before the wallet sees it.
    const tampered = Buffer.from(buy.data);
    tampered.writeBigUInt64LE(20_000_000n, 8);
    expect(() => adapter.verify([instructions[0]!, { ...buy, data: tampered }], quote, USER)).toThrow(/SOL budget/);
    const lowered = Buffer.from(buy.data);
    lowered.writeBigUInt64LE(1n, 16);
    expect(() => adapter.verify([instructions[0]!, { ...buy, data: lowered }], quote, USER)).toThrow(/token floor/);
    // The exact-tokens buy, which bought only the floor, is no longer what the adapter signs.
    const exactTokens = Buffer.from(buy.data);
    Buffer.from('66063d1201daebea', 'hex').copy(exactTokens, 0);
    expect(() => adapter.verify([instructions[0]!, { ...buy, data: exactTokens }], quote, USER)).toThrow(/not buy_exact_sol_in/);
    expect(() => adapter.verify([buy], { ...quote, mint: 'So11111111111111111111111111111111111111112' }, USER)).toThrow(/mint/);
    expect(() => adapter.verify([{ ...instructions[0]!, accounts: ['Other111111111111111111111111111111111111111', ...instructions[0]!.accounts.slice(1)] }, buy], quote, USER)).toThrow(/token account/);
    expect(() => adapter.verify([buy, buy], quote, USER)).toThrow(/one pump.fun instruction/);
  });

  it('accepts every fee recipient the SDK may pick, the single reserved one of mayhem mode included', async () => {
    const quote = await adapter.quote({ side: 'buy', mint: CURVE.mint, amountIn: 10_000_000n, slippageBps: 100, user: USER });
    const built = await adapter.build(quote, USER);
    const instructions = decodeInstructions(assembleTransaction(USER, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', built.instructions));
    const buy = instructions[1]!;
    type Key = { toBase58(): string };
    const global = (quote.state as { global: { feeRecipient: Key; feeRecipients: Key[]; reservedFeeRecipient: Key; reservedFeeRecipients: Key[] } }).global;
    const known = new Set([global.feeRecipient, ...global.feeRecipients, ...global.reservedFeeRecipients].map((k) => k.toBase58()));
    const at = buy.accounts.findIndex((a) => known.has(a));
    expect(at).toBeGreaterThanOrEqual(0);
    const paying = (account: string) => ({ ...buy, accounts: buy.accounts.map((a, i) => (i === at ? account : a)) });
    // A mayhem-mode coin's fee may go to the single reserved recipient.
    expect(() => adapter.verify([instructions[0]!, paying(global.reservedFeeRecipient.toBase58())], quote, USER)).not.toThrow();
    expect(() => adapter.verify([instructions[0]!, paying('Unknown1111111111111111111111111111111111111')], quote, USER)).toThrow(/fee recipient/);
  });

  it('builds a sell with the quoted floor and no token account creation', async () => {
    const quote = await adapter.quote({ side: 'sell', mint: CURVE.mint, amountIn: 1_000_000_000n, slippageBps: 50, user: USER });
    const built = await adapter.build(quote, USER);
    const instructions = decodeInstructions(assembleTransaction(USER, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', built.instructions));
    expect(instructions.map((ix) => ix.programId)).toEqual([PUMPFUN_PROGRAM]);
    expect(instructions[0]!.data.readBigUInt64LE(8)).toBe(1_000_000_000n);
    expect(instructions[0]!.data.readBigUInt64LE(16)).toBe(quote.minOutAmount);
    expect(() => adapter.verify(instructions, quote, USER)).not.toThrow();
  });

  it('refuses a curve quoted in a token other than SOL (the PUMP-quoted curve recorded at slot 449286893)', async () => {
    const pumpQuoted = curveFixture('pumpfun-curve-pump-quoted.json');
    const other = new PumpfunAdapter({ rpc: fixtureRpc(pumpQuoted) });
    await expect(other.quote({ side: 'buy', mint: pumpQuoted.mint, amountIn: 10_000_000n, slippageBps: 100, user: USER })).rejects.toMatchObject({ code: 'UNSUPPORTED' });

    // After it completes, the answer stays UNSUPPORTED: its PumpSwap pool is quoted in the same token,
    // so MIGRATED would send the caller on to a SOL pool that does not exist.
    const curveAccount = pumpQuoted.accounts[pumpQuoted.pdas.bondingCurve]!;
    const data = Buffer.from(curveAccount.data, 'base64');
    data[8 + 40] = 1;
    const completed = { ...pumpQuoted, accounts: { ...pumpQuoted.accounts, [pumpQuoted.pdas.bondingCurve]: { ...curveAccount, data: data.toString('base64') } } };
    await expect(new PumpfunAdapter({ rpc: fixtureRpc(completed) }).quote({ side: 'sell', mint: pumpQuoted.mint, amountIn: 1_000_000n, slippageBps: 100, user: USER })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringContaining('on its curve and on PumpSwap'),
    });
  });

  it('refuses a completed curve, a zero amount and a curve that is not there', async () => {
    const completed = { ...CURVE, accounts: { ...CURVE.accounts } };
    const curveAccount = CURVE.accounts[CURVE.pdas.bondingCurve]!;
    const data = Buffer.from(curveAccount.data, 'base64');
    // `complete` is the bool after five u64s in the account body (8-byte discriminator first).
    data[8 + 40] = 1;
    completed.accounts[CURVE.pdas.bondingCurve] = { ...curveAccount, data: data.toString('base64') };
    await expect(new PumpfunAdapter({ rpc: fixtureRpc(completed) }).quote({ side: 'buy', mint: CURVE.mint, amountIn: 1n, slippageBps: 100, user: USER })).rejects.toMatchObject({ code: 'MIGRATED' });
    await expect(adapter.quote({ side: 'buy', mint: CURVE.mint, amountIn: 0n, slippageBps: 100, user: USER })).rejects.toBeInstanceOf(LaunchpadError);
    const missing = { ...CURVE, accounts: { ...CURVE.accounts, [CURVE.pdas.bondingCurve]: null } };
    await expect(new PumpfunAdapter({ rpc: fixtureRpc(missing) }).quote({ side: 'buy', mint: CURVE.mint, amountIn: 1n, slippageBps: 100, user: USER })).rejects.toMatchObject({ code: 'NOT_ON_CURVE' });
  });

  it('reads a curve address someone only sent lamports to as no curve', async () => {
    // Seen on mainnet for USDC: the address exists, holds lamports, has no data and belongs to the System program.
    const funded = fixtureRpc(CURVE, { [CURVE.pdas.bondingCurve]: { data: Buffer.alloc(0), owner: '11111111111111111111111111111111', lamports: 890_880 } });
    await expect(new PumpfunAdapter({ rpc: funded }).quote({ side: 'buy', mint: CURVE.mint, amountIn: 1n, slippageBps: 100, user: USER })).rejects.toMatchObject({ code: 'NOT_ON_CURVE' });
  });
});
