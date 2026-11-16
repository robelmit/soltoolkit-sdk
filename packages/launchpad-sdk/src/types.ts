/**
 * What a launchpad adapter is.
 *
 * An adapter knows one program: how to read its curve or pool, how to quote a
 * swap against that state with the venue's own maths, how to emit the swap
 * instructions, and how to check that a set of instructions is exactly that
 * swap. It never adds a compute budget, a fee or a tip; the caller does, the
 * same way for every venue.
 */

import type { TransactionInstruction } from '@solana/web3.js';
import type { DecodedInstruction } from './solana';

/** The venues this SDK trades on directly. */
export type Venue = 'pumpfun' | 'pumpswap' | 'meteora-dbc';

export type Side = 'buy' | 'sell';

export interface LaunchpadQuoteRequest {
  readonly side: Side;
  /** The launchpad token. */
  readonly mint: string;
  /** Base units of the input asset: lamports for a buy, raw token units for a sell. */
  readonly amountIn: bigint;
  /** The tolerance the transaction is built with, in basis points (100 = 1 %). */
  readonly slippageBps: number;
  /** The wallet that will sign. */
  readonly user: string;
  /** The pool address, when you already know it. Saves the lookup on venues that need one. */
  readonly pool?: string;
}

export interface LaunchpadQuote {
  readonly venue: Venue;
  readonly side: Side;
  readonly mint: string;
  readonly inAmount: bigint;
  /** Expected output before slippage, net of the venue's own fees. */
  readonly outAmount: bigint;
  /** The floor encoded in the instruction: the least the wallet accepts. */
  readonly minOutAmount: bigint;
  readonly slippageBps: number;
  /** Protocol and creator fees the venue keeps, in lamports. */
  readonly venueFeeLamports: bigint;
  /** Spot price after the trade over spot before it, in basis points; null when the venue's maths does not give it. */
  readonly priceImpactBps: number | null;
  /** The curve or pool snapshot the instructions are built from. Opaque to the caller. */
  readonly state: unknown;
  /** Milliseconds since the epoch. */
  readonly quotedAt: number;
}

export interface BuiltSwap {
  readonly instructions: readonly TransactionInstruction[];
  /** Compute units the swap needs. Add headroom for anything you append. */
  readonly computeUnits: number;
}

export interface LaunchpadAdapter {
  readonly venue: Venue;
  /** Programs the swap instructions may invoke. */
  readonly programs: readonly string[];
  quote(request: LaunchpadQuoteRequest): Promise<LaunchpadQuote>;
  /** The swap instructions for this quote (token account creation included when the wallet lacks one). */
  build(quote: LaunchpadQuote, user: string): Promise<BuiltSwap>;
  /**
   * Check that these instructions encode this quote and nothing else: one swap,
   * the same mint, amount and floor, for this wallet. Throws when they do not.
   * Run it on instructions decoded from the bytes about to be signed, so a
   * builder bug or a tampered payload never reaches the wallet.
   */
  verify(instructions: readonly DecodedInstruction[], quote: LaunchpadQuote, user: string): void;
}

export type LaunchpadErrorCode =
  /** The token has no curve or pool on this venue. */
  | 'NOT_ON_CURVE'
  /** The curve is complete; the token trades elsewhere now. */
  | 'MIGRATED'
  /** The state could not be read, or is not the shape the adapter expects. */
  | 'STATE_UNAVAILABLE'
  /** The amount or the slippage cannot be filled. */
  | 'AMOUNT'
  /** The pool is real but not one this adapter trades (for example, not quoted in SOL). */
  | 'UNSUPPORTED';

export class LaunchpadError extends Error {
  constructor(
    readonly venue: Venue,
    readonly code: LaunchpadErrorCode,
    message: string,
  ) {
    super(`${venue}: ${message}`);
    this.name = 'LaunchpadError';
  }
}
