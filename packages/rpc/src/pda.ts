/**
 * Program-derived addresses, without a Solana SDK.
 *
 * A program-derived address is the SHA-256 of the seeds, a bump byte, the
 * program id and a marker string, for the highest bump whose hash is NOT a
 * point on the ed25519 curve (so no private key can exist for it). The only
 * part that needs care is the curve test, done here with BigInt arithmetic.
 *
 * Uses `node:crypto`, so this file is for Node, not the browser.
 */

import { createHash } from 'node:crypto';
import { addressBytes, base58Encode } from './base58';

const P = 2n ** 255n - 19n;
const MARKER = Buffer.from('ProgramDerivedAddress');

function mod(value: bigint): bigint {
  const result = value % P;
  return result >= 0n ? result : result + P;
}

function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let factor = mod(base);
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * factor) % P;
    factor = (factor * factor) % P;
    remaining >>= 1n;
  }
  return result;
}

/** The curve constant d = -121665 / 121666. */
const D = mod(-121665n * power(121666n, P - 2n));

/**
 * True when the 32 bytes are a compressed point on the ed25519 curve.
 *
 * The bytes hold y (little-endian, top bit is the sign of x). The point exists
 * when x^2 = (y^2 - 1) / (d y^2 + 1) has a square root. As on chain, y is read
 * modulo p and the sign bit is not checked.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(bytes[i]!);
  y = mod(y & ((1n << 255n) - 1n));

  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);

  // Candidate root of u/v: u v^3 (u v^7)^((p-5)/8). It is a root when v x^2 is u or -u.
  const v3 = (((v * v) % P) * v) % P;
  const v7 = (((v3 * v3) % P) * v) % P;
  const x = (((u * v3) % P) * power((u * v7) % P, (P - 5n) / 8n)) % P;
  const check = (v * ((x * x) % P)) % P;
  return check === u || check === mod(-u);
}

export type Seed = Uint8Array | string;

function seedBytes(seed: Seed): Uint8Array {
  const bytes = typeof seed === 'string' ? Buffer.from(seed, 'utf8') : seed;
  if (bytes.length > 32) throw new Error(`A seed is at most 32 bytes, got ${bytes.length}`);
  return bytes;
}

/**
 * The program-derived address for these seeds, and its bump.
 *
 * A string seed is taken as UTF-8 text. Pass an address as bytes
 * (`addressBytes(address)`), not as its base58 text.
 */
export function findProgramAddress(seeds: readonly Seed[], programId: string): { address: string; bump: number } {
  if (seeds.length > 16) throw new Error(`At most 16 seeds, got ${seeds.length}`);
  const program = addressBytes(programId);
  const parts = seeds.map(seedBytes);

  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash('sha256');
    for (const part of parts) hash.update(part);
    hash.update(Uint8Array.of(bump));
    hash.update(program);
    hash.update(MARKER);
    const digest = new Uint8Array(hash.digest());
    if (!isOnCurve(digest)) return { address: base58Encode(digest), bump };
  }
  // 256 hashes in a row on the curve: not something that happens.
  throw new Error('No program-derived address for these seeds');
}

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** The associated token account of a wallet for a mint. Pass `TOKEN_2022_PROGRAM` for a Token-2022 mint. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM): string {
  return findProgramAddress([addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint)], ASSOCIATED_TOKEN_PROGRAM).address;
}
