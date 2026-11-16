/**
 * pump.fun's SDK, loaded through its CommonJS build.
 *
 * Its ES-module build pulls in a package that names an export of a CommonJS
 * module (`BN` from `@coral-xyz/anchor`), which Node 22 refuses to load. The
 * CommonJS build is the same code and loads on every supported Node, so both
 * of this package's builds take that one.
 */

import { createRequire } from 'node:module';
import type * as PumpSdk from '@pump-fun/pump-sdk';

const load = createRequire(import.meta.url);
const sdk = load('@pump-fun/pump-sdk') as typeof PumpSdk;

export const {
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  GLOBAL_PDA,
  bondingCurvePda,
  canonicalPumpPoolPda,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
  isSolLikeQuoteMint,
  pumpIdl,
} = sdk;

export type { BondingCurve, FeeConfig, Global } from '@pump-fun/pump-sdk';
