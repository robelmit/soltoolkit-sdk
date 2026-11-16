/**
 * pump.fun bonding curve.
 *
 * The program has grown fee tiers by market cap, creator vaults, volume
 * accumulators and a fee program, all of which pump.fun's own SDK tracks.
 * This adapter reads the accounts a quote needs in one RPC round trip,
 * quotes with the SDK's maths (`getBuyTokenAmountFromSolAmount`,
 * `getSellSolAmountFromTokenAmount`), and emits the SDK's instructions.
 *
 * Buys are budgeted: the transaction spends exactly the SOL the trader
 * committed (`buy_exact_sol_in`, fees included) for at least the quoted
 * tokens less the slippage allowance, so the wallet never pays more than
 * `amountIn`. The exact-tokens `buy` would buy only the floor, so a 20 %
 * allowance would buy 20 % fewer tokens.
 * Sells encode the SDK's `min_sol_output` under the same allowance.
 */

import {
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  GLOBAL_PDA,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  isSolLikeQuoteMint,
  pumpIdl,
  type BondingCurve,
  type FeeConfig,
  type Global,
} from '@pump-fun/pump-sdk';
import { PublicKey, TransactionInstruction, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, associatedTokenAddress, type DecodedInstruction, type RpcAccount, type SolanaRpc } from './solana';
import { LaunchpadError, type BuiltSwap, type LaunchpadAdapter, type LaunchpadQuote, type LaunchpadQuoteRequest } from './types';

export const PUMPFUN_PROGRAM = PUMP_PROGRAM_ID.toBase58();
export const PUMPFUN_FEE_PROGRAM = PUMP_FEE_PROGRAM_ID.toBase58();

/** The curve accounts a quote is made from, as read from the chain (or a fixture). */
export interface PumpfunCurveState {
  readonly slot: number | null;
  readonly global: Global;
  readonly feeConfig: FeeConfig | null;
  readonly bondingCurve: BondingCurve;
  readonly bondingCurveAccount: AccountInfo<Buffer>;
  readonly mintSupply: bigint;
  readonly tokenProgram: string;
  /** The user's token account for the mint, when it exists. */
  readonly userTokenAccount: AccountInfo<Buffer> | null;
}

export interface PumpfunAdapterOptions {
  readonly rpc: SolanaRpc;
  readonly now?: () => number;
  /** Compute units the swap instruction is budgeted with. */
  readonly computeUnits?: number;
}

const SWAP_COMPUTE_UNITS = 250_000;

const toAccountInfo = (account: RpcAccount): AccountInfo<Buffer> => ({
  data: account.data,
  owner: new PublicKey(account.owner),
  lamports: account.lamports,
  executable: false,
});

const bn = (value: bigint): BN => new BN(value.toString());
const big = (value: BN): bigint => BigInt(value.toString());

/**
 * The SDK's buy as `buy_exact_sol_in`: the same accounts and layout, the committed SOL as the budget (fees come out of
 * it) and the slippage-net token amount as the floor, in that order.
 */
function asExactSolIn(instructions: TransactionInstruction[], quote: LaunchpadQuote): TransactionInstruction[] {
  const buy = discriminatorOf('buy');
  let budgeted = 0;
  const out = instructions.map((ix) => {
    if (ix.programId.toBase58() !== PUMPFUN_PROGRAM || !ix.data.subarray(0, 8).equals(buy)) return ix;
    budgeted += 1;
    const data = Buffer.from(ix.data);
    discriminatorOf('buy_exact_sol_in').copy(data, 0);
    data.writeBigUInt64LE(quote.inAmount, 8);
    data.writeBigUInt64LE(quote.minOutAmount, 16);
    return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
  });
  if (budgeted !== 1) throw new LaunchpadError('pumpfun', 'STATE_UNAVAILABLE', `expected one pump.fun buy to budget, found ${budgeted}`);
  return out;
}

/** Anchor discriminators from the IDL the SDK ships, so nothing is hardcoded here. */
function discriminatorOf(name: string): Buffer {
  const instruction = (pumpIdl as { instructions: { name: string; discriminator: number[] }[] }).instructions.find((ix) => ix.name === name);
  if (!instruction) throw new Error(`pump IDL has no instruction ${name}`);
  return Buffer.from(instruction.discriminator);
}

export class PumpfunAdapter implements LaunchpadAdapter {
  readonly venue = 'pumpfun' as const;
  readonly programs = [PUMPFUN_PROGRAM, PUMPFUN_FEE_PROGRAM] as const;
  private readonly now: () => number;

  constructor(private readonly options: PumpfunAdapterOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Read everything a quote and a build need in one wave: the mint, the curve's accounts and the wallet's token account
   * in one `getMultipleAccounts`, the mint's supply beside it. The token account's address depends on the mint's token
   * program, which that same answer says, so both candidates are asked for and the right one kept: nothing waits on the
   * mint first.
   */
  async readState(mint: string, user: string): Promise<PumpfunCurveState> {
    const curve = bondingCurvePda(new PublicKey(mint)).toBase58();
    const splAta = associatedTokenAddress(user, mint, TOKEN_PROGRAM);
    const token2022Ata = associatedTokenAddress(user, mint, TOKEN_2022_PROGRAM);
    const supplyRead = this.options.rpc.getTokenSupply(mint);
    // A mint that is not there is said below, from the accounts, not as the supply call's RPC error.
    supplyRead.catch(() => undefined);
    const [mintAccount, global, feeConfig, bonding, splToken, token2022Token] = await this.options.rpc.getMultipleAccounts([
      mint,
      GLOBAL_PDA.toBase58(),
      PUMP_FEE_CONFIG_PDA.toBase58(),
      curve,
      splAta,
      token2022Ata,
    ]);
    if (!mintAccount) throw new LaunchpadError('pumpfun', 'STATE_UNAVAILABLE', `mint ${mint} not found`);
    const tokenProgram = mintAccount.owner === TOKEN_2022_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
    const userToken = tokenProgram === TOKEN_2022_PROGRAM ? token2022Token : splToken;
    if (!global) throw new LaunchpadError('pumpfun', 'STATE_UNAVAILABLE', 'global account missing');
    // Anyone can send lamports to the curve address of a token that was never launched here, which leaves an empty
    // account owned by the System program. Only an account the pump.fun program owns is a curve.
    if (!bonding || bonding.owner !== PUMPFUN_PROGRAM) throw new LaunchpadError('pumpfun', 'NOT_ON_CURVE', `${mint} has no bonding curve`);
    const bondingCurveAccount = toAccountInfo(bonding);
    const bondingCurve = PUMP_SDK.decodeBondingCurve(bondingCurveAccount);
    const supply = await supplyRead;
    return {
      slot: null,
      global: PUMP_SDK.decodeGlobal(toAccountInfo(global)),
      feeConfig: feeConfig ? PUMP_SDK.decodeFeeConfig(toAccountInfo(feeConfig)) : null,
      bondingCurve,
      bondingCurveAccount,
      mintSupply: supply.amount,
      tokenProgram,
      userTokenAccount: userToken ? toAccountInfo(userToken) : null,
    };
  }

  async quote(request: LaunchpadQuoteRequest): Promise<LaunchpadQuote> {
    const state = await this.readState(request.mint, request.user);
    return this.quoteFrom(state, request);
  }

  /** Pure: the quote for a request against a state already read (tests feed a recorded one). */
  quoteFrom(state: PumpfunCurveState, request: LaunchpadQuoteRequest): LaunchpadQuote {
    const { bondingCurve, global, feeConfig } = state;
    // Before the migration check: a token quoted in another asset keeps that quote on PumpSwap, where the
    // SOL pool this SDK looks for does not exist. Saying so here gives the reason instead of "no venue".
    if (!isSolLikeQuoteMint(bondingCurve.quoteMint)) throw new LaunchpadError('pumpfun', 'UNSUPPORTED', `${request.mint} is quoted in ${bondingCurve.quoteMint.toBase58()}, not SOL${bondingCurve.complete ? ', on its curve and on PumpSwap' : ''}`);
    if (bondingCurve.complete) throw new LaunchpadError('pumpfun', 'MIGRATED', `${request.mint} has completed its curve; trade it on PumpSwap`);
    if (request.amountIn <= 0n) throw new LaunchpadError('pumpfun', 'AMOUNT', 'amount must be positive');
    if (!Number.isInteger(request.slippageBps) || request.slippageBps < 0 || request.slippageBps > 10_000) throw new LaunchpadError('pumpfun', 'AMOUNT', 'slippage out of range');
    const mintSupply = bn(state.mintSupply);
    const quotedAt = this.now();
    if (request.side === 'buy') {
      const tokens = big(getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply, bondingCurve, amount: bn(request.amountIn), quoteMint: bondingCurve.quoteMint }));
      if (tokens <= 0n) throw new LaunchpadError('pumpfun', 'AMOUNT', 'amount buys no tokens');
      const available = big(bondingCurve.realTokenReserves);
      if (tokens > available) throw new LaunchpadError('pumpfun', 'AMOUNT', `only ${available} tokens remain on the curve`);
      const minOut = (tokens * BigInt(10_000 - request.slippageBps)) / 10_000n;
      if (minOut <= 0n) throw new LaunchpadError('pumpfun', 'AMOUNT', 'slippage leaves no tokens');
      return {
        venue: 'pumpfun',
        side: 'buy',
        mint: request.mint,
        inAmount: request.amountIn,
        outAmount: tokens,
        minOutAmount: minOut,
        slippageBps: request.slippageBps,
        venueFeeLamports: venueFee(state, request.amountIn),
        priceImpactBps: priceImpactBps(bondingCurve, request.amountIn),
        state,
        quotedAt,
      };
    }
    const lamports = big(getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply, bondingCurve, amount: bn(request.amountIn) }));
    if (lamports <= 0n) throw new LaunchpadError('pumpfun', 'AMOUNT', 'amount sells for no SOL');
    const minOut = (lamports * BigInt(10_000 - request.slippageBps)) / 10_000n;
    return {
      venue: 'pumpfun',
      side: 'sell',
      mint: request.mint,
      inAmount: request.amountIn,
      outAmount: lamports,
      minOutAmount: minOut,
      slippageBps: request.slippageBps,
      venueFeeLamports: venueFee(state, lamports),
      priceImpactBps: null,
      state,
      quotedAt,
    };
  }

  async build(quote: LaunchpadQuote, user: string): Promise<BuiltSwap> {
    const state = quote.state as PumpfunCurveState;
    const mint = new PublicKey(quote.mint);
    const userKey = new PublicKey(user);
    const tokenProgram = new PublicKey(state.tokenProgram);
    const instructions =
      quote.side === 'buy'
        ? await PUMP_SDK.buyInstructions({
            global: state.global,
            bondingCurveAccountInfo: state.bondingCurveAccount,
            bondingCurve: state.bondingCurve,
            associatedUserAccountInfo: state.userTokenAccount,
            mint,
            user: userKey,
            // Built as the exact-tokens buy, then budgeted (asExactSolIn): the committed SOL in, the slippage-net tokens as the floor.
            amount: bn(quote.minOutAmount),
            solAmount: bn(quote.inAmount),
            slippage: 0,
            tokenProgram,
          }).then((built) => asExactSolIn(built, quote))
        : await PUMP_SDK.sellInstructions({
            global: state.global,
            bondingCurveAccountInfo: state.bondingCurveAccount,
            bondingCurve: state.bondingCurve,
            mint,
            user: userKey,
            amount: bn(quote.inAmount),
            // The floor is our own number; the SDK subtracts nothing more.
            solAmount: bn(quote.minOutAmount),
            slippage: 0,
            tokenProgram,
            mayhemMode: state.bondingCurve.isMayhemMode,
          });
    return { instructions, computeUnits: this.options.computeUnits ?? SWAP_COMPUTE_UNITS };
  }

  verify(instructions: readonly DecodedInstruction[], quote: LaunchpadQuote, user: string): void {
    const swaps = instructions.filter((ix) => ix.programId === PUMPFUN_PROGRAM);
    if (swaps.length !== 1) throw new Error(`expected one pump.fun instruction, found ${swaps.length}`);
    const others = instructions.filter((ix) => ix.programId !== PUMPFUN_PROGRAM);
    for (const ix of others) {
      if (ix.programId !== ASSOCIATED_TOKEN_PROGRAM) throw new Error(`unexpected instruction for ${ix.programId}`);
      // Only the user's own token account may be created, by the user, for this mint.
      const [payer, , owner, mint] = ix.accounts;
      if (payer !== user || owner !== user || mint !== quote.mint) throw new Error('token account creation is not for the wallet and mint');
    }
    const swap = swaps[0]!;
    const name = quote.side === 'buy' ? 'buy_exact_sol_in' : 'sell';
    if (swap.data.length < 24 || !swap.data.subarray(0, 8).equals(discriminatorOf(name))) throw new Error(`pump.fun instruction is not ${name}`);
    const amount = swap.data.readBigUInt64LE(8);
    const limit = swap.data.readBigUInt64LE(16);
    if (quote.side === 'buy') {
      if (amount !== quote.inAmount) throw new Error('buy SOL budget differs from the committed amount');
      if (limit !== quote.minOutAmount) throw new Error('buy token floor differs from the quote');
    } else {
      if (amount !== quote.inAmount) throw new Error('sell token amount differs from the quote');
      if (limit !== quote.minOutAmount) throw new Error('sell SOL floor differs from the quote');
    }
    if (!swap.accounts.includes(quote.mint)) throw new Error('instruction does not reference the quoted mint');
    if (!swap.accounts.includes(user)) throw new Error('instruction does not reference the wallet');
    const state = quote.state as PumpfunCurveState;
    // Every account the SDK may pick (`getFeeRecipient`): the fee recipients, and for a mayhem-mode coin the single
    // reserved one or a reserved list entry. Leave the single reserved one out and a mayhem trade is refused at random.
    const global = state.global;
    const feeRecipients = new Set([global.feeRecipient, ...global.feeRecipients, global.reservedFeeRecipient, ...global.reservedFeeRecipients].filter((k) => k !== undefined && k !== null).map((k) => k.toBase58()));
    if (!swap.accounts.some((a) => feeRecipients.has(a))) throw new Error('instruction pays no known pump.fun fee recipient');
  }
}

/** Protocol + creator fee the program keeps on the SOL leg, from the fee tier the curve's market cap selects. */
function venueFee(state: PumpfunCurveState, solLamports: bigint): bigint {
  const { global, feeConfig, bondingCurve } = state;
  let protocolBps = big(global.feeBasisPoints);
  let creatorBps = big(global.creatorFeeBasisPoints);
  if (feeConfig) {
    const marketCap = (big(bondingCurve.virtualQuoteReserves) * state.mintSupply) / (big(bondingCurve.virtualTokenReserves) || 1n);
    const tiers = feeConfig.feeTiers;
    if (tiers.length > 0) {
      let fees = tiers[0]!.fees;
      for (const tier of [...tiers].reverse()) {
        if (marketCap >= big(tier.marketCapLamportsThreshold)) {
          fees = tier.fees;
          break;
        }
      }
      protocolBps = big(fees.protocolFeeBps);
      creatorBps = big(fees.creatorFeeBps);
    }
  }
  return (solLamports * (protocolBps + creatorBps) + 9_999n) / 10_000n;
}

/** Spot price after the buy over spot before, from the virtual reserves (constant product). */
function priceImpactBps(curve: BondingCurve, solIn: bigint): number | null {
  const vSol = big(curve.virtualQuoteReserves);
  const vTok = big(curve.virtualTokenReserves);
  if (vSol <= 0n || vTok <= 0n) return null;
  const k = vSol * vTok;
  const solAfter = vSol + solIn;
  const tokAfter = k / solAfter;
  if (tokAfter <= 0n) return null;
  // price = sol / tok; impact = priceAfter / priceBefore − 1 = (solAfter·vTok) / (tokAfter·vSol) − 1
  const ratio = (solAfter * vTok * 10_000n) / (tokAfter * vSol);
  return Number(ratio - 10_000n);
}
