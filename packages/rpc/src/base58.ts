/**
 * Base58 (the Bitcoin alphabet), as Solana writes addresses and signatures.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((char, index) => [char, index]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  // Base-256 to base-58, one input byte at a time.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]!];
  return out;
}

/** Throws on a character outside the alphabet: a mistyped address is an error, not an empty one. */
export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;

  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i += 1) {
    const value = INDEX.get(text[i]!);
    if (value === undefined) throw new Error(`Not base58: character "${text[i]}" at ${i}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

/** A Solana address as its 32 bytes. Throws when the text is not a 32-byte base58 value. */
export function addressBytes(address: string): Uint8Array {
  const bytes = base58Decode(address);
  if (bytes.length !== 32) throw new Error(`Not a Solana address (${bytes.length} bytes): ${address}`);
  return bytes;
}

/** True when the text is a 32-byte base58 value. Says nothing about whether an account exists there. */
export function isAddress(text: string): boolean {
  if (text.length < 32 || text.length > 44) return false;
  try {
    return base58Decode(text).length === 32;
  } catch {
    return false;
  }
}
