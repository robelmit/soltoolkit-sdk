/**
 * The Solana pieces every adapter shares: well-known program ids, the
 * associated token account derivation, assembling an unsigned v0 transaction,
 * decoding one back into instructions (which is what `verify` reads), and a
 * thin JSON-RPC client over plain `fetch`.
 *
 * Nothing here signs or sends.
 */

import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** SPL Token instruction tags the SOL wrappers use. */
export const TOKEN_IX_CLOSE_ACCOUNT = 9;
export const TOKEN_IX_SYNC_NATIVE = 17;

export const MAX_COMPUTE_UNITS = 1_400_000;

/** The associated token account of `owner` for `mint` under the given token program. */
export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string = TOKEN_PROGRAM): string {
  const [address] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBytes(), new PublicKey(tokenProgram).toBytes(), new PublicKey(mint).toBytes()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  );
  return address.toBase58();
}

// ---------------------------------------------------------------------------
// Reading a transaction back
// ---------------------------------------------------------------------------

/** One instruction as `verify` reads it: every account resolved to base58. */
export interface DecodedInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: Buffer;
}

/**
 * The instructions of a transaction, with every account resolved to base58.
 * A transaction that uses address lookup tables is refused: its accounts
 * cannot be known from the bytes alone, and nothing this SDK builds uses one.
 */
export function decodeInstructions(transaction: VersionedTransaction): DecodedInstruction[] {
  const message = transaction.message;
  if (message.addressTableLookups.length > 0) throw new Error('lookup-table transactions are not decoded here');
  const keys = message.staticAccountKeys.map((k) => k.toBase58());
  return message.compiledInstructions.map((ix) => {
    const programId = keys[ix.programIdIndex];
    const accounts = ix.accountKeyIndexes.map((i) => keys[i]);
    if (!programId || accounts.some((a) => a === undefined)) throw new Error('instruction references an unknown account');
    return { programId, accounts: accounts as string[], data: Buffer.from(ix.data) };
  });
}

export interface SystemTransfer {
  readonly from: string;
  readonly to: string;
  readonly lamports: bigint;
}

/**
 * Every `SystemProgram.transfer` among the instructions, in order. A transfer
 * whose data runs past its amount is refused, not skipped: the runtime ignores
 * the extra bytes and still moves the lamports.
 */
export function systemTransfersOf(instructions: readonly DecodedInstruction[]): SystemTransfer[] {
  const out: SystemTransfer[] = [];
  for (const ix of instructions) {
    // Shorter data does not decode as a transfer: the runtime fails the transaction, so nothing moves.
    if (ix.programId !== SYSTEM_PROGRAM || ix.data.length < 12 || ix.data.readUInt32LE(0) !== 2) continue;
    if (ix.data.length !== 12) throw new Error('System transfer carries data after its amount');
    const [from, to] = ix.accounts;
    // Without both accounts the runtime fails the transaction too.
    if (!from || !to) continue;
    out.push({ from, to, lamports: ix.data.readBigUInt64LE(4) });
  }
  return out;
}

export interface ComputeBudgetOf {
  readonly units: number | null;
  readonly microLamportsPerUnit: bigint | null;
  /** The priority fee the transaction pays in total, when both the limit and the price are set. */
  readonly priorityFeeLamports: bigint | null;
}

/** The compute unit limit and price a transaction sets, null where it sets none. */
export function computeBudgetOf(instructions: readonly DecodedInstruction[]): ComputeBudgetOf {
  let units: number | null = null;
  let price: bigint | null = null;
  for (const ix of instructions) {
    if (ix.programId !== COMPUTE_BUDGET_PROGRAM) continue;
    if (ix.data[0] === 2 && ix.data.length === 5) units = ix.data.readUInt32LE(1);
    else if (ix.data[0] === 3 && ix.data.length === 9) price = ix.data.readBigUInt64LE(1);
  }
  const priorityFeeLamports = units !== null && price !== null ? (BigInt(units) * price + 999_999n) / 1_000_000n : null;
  return { units, microLamportsPerUnit: price, priorityFeeLamports };
}

/**
 * A venue that settles in wrapped SOL creates the wallet's WSOL account, funds
 * it with a lamport transfer, syncs it and closes it back to the wallet. Those
 * instructions are allowed only in that shape: a transfer from the wallet to
 * its own WSOL account, a sync, a close whose destination and owner are the
 * wallet, and a token account created by the wallet for the wallet. Anything
 * else throws.
 */
export function assertOwnWsolPlumbing(ix: DecodedInstruction, user: string): void {
  const wsolAta = associatedTokenAddress(user, WSOL_MINT, TOKEN_PROGRAM);
  if (ix.programId === SYSTEM_PROGRAM) {
    const [transfer] = systemTransfersOf([ix]);
    if (!transfer || transfer.from !== user || transfer.to !== wsolAta) throw new Error('lamport transfer is not the wallet funding its own WSOL account');
    return;
  }
  if (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM) {
    const tag = ix.data[0];
    if (tag === TOKEN_IX_SYNC_NATIVE) return;
    if (tag === TOKEN_IX_CLOSE_ACCOUNT) {
      if (ix.accounts[1] !== user || ix.accounts[2] !== user) throw new Error('token account close does not return lamports to the wallet');
      return;
    }
    throw new Error(`unexpected token instruction ${tag}`);
  }
  if (ix.programId === ASSOCIATED_TOKEN_PROGRAM) {
    const [payer, , owner] = ix.accounts;
    if (payer !== user || owner !== user) throw new Error('token account creation is not for the wallet');
    return;
  }
  throw new Error(`unexpected instruction for ${ix.programId}`);
}

// ---------------------------------------------------------------------------
// Building a transaction
// ---------------------------------------------------------------------------

const u64 = (value: bigint, what: string): bigint => {
  if (value < 0n || value > 18_446_744_073_709_551_615n) throw new RangeError(`${what} out of u64 range: ${value}`);
  return value;
};

/** The compute unit limit and the price that pays `priorityFeeLamports` in total for that limit. */
export function computeBudgetInstructions(units: number, priorityFeeLamports: bigint): TransactionInstruction[] {
  if (!Number.isInteger(units) || units < 1 || units > MAX_COMPUTE_UNITS) throw new RangeError(`compute units out of range: ${units}`);
  u64(priorityFeeLamports, 'priority fee');
  // The price is in micro-lamports per unit; round up so the lamports actually paid reach the target.
  const microLamports = (priorityFeeLamports * 1_000_000n + BigInt(units) - 1n) / BigInt(units);
  return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports })];
}

/** An unsigned v0 transaction whose only fee payer is `payer`. No lookup tables. */
export function assembleTransaction(payer: string, recentBlockhash: string, instructions: readonly TransactionInstruction[]): VersionedTransaction {
  if (instructions.length === 0) throw new Error('no instructions');
  const message = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash, instructions: [...instructions] }).compileToV0Message();
  return new VersionedTransaction(message);
}

export function encodeTransaction(transaction: VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString('base64');
}

export function decodeTransaction(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

export interface RpcAccount {
  readonly data: Buffer;
  readonly owner: string;
  readonly lamports: number;
}

export interface SimulationResult {
  readonly err: unknown;
  readonly logs: readonly string[];
  readonly unitsConsumed: number | null;
}

export class SolanaRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'SolanaRpcError';
  }
}

/** A read the node throttled (HTTP 429); still a SolanaRpcError to every caller that does not retry. */
export class SolanaRpcThrottled extends SolanaRpcError {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'SolanaRpcError';
  }
}

export interface SolanaRpcOptions {
  /** Any Solana JSON-RPC endpoint. The public one works for a try-out; use your own for real traffic. */
  readonly url: string;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Retries of a read the node throttled (HTTP 429); default 3. */
  readonly throttleRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The handful of RPC reads the adapters need, over plain fetch so tests can fake the wire. It has no method that sends. */
export class SolanaRpc {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private id = 0;

  constructor(private readonly options: SolanaRpcOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  get url(): string {
    return this.options.url;
  }

  /**
   * One JSON-RPC call. A read the node throttles (HTTP 429) is asked again
   * after Retry-After (at most 2 s) or 250 ms, 500 ms, 1 s; any other failure
   * and a still-throttled read surface to the caller.
   */
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const retries = this.options.throttleRetries ?? 3;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.once<T>(method, params);
      } catch (error) {
        if (!(error instanceof SolanaRpcThrottled) || attempt >= retries) throw error;
        await sleep(Math.min(2_000, error.retryAfterMs ?? 250 * 2 ** attempt));
      }
    }
  }

  private async once<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: controller.signal,
      });
      if (response.status === 429) {
        const after = Number(response.headers.get('retry-after'));
        throw new SolanaRpcThrottled(`${method}: HTTP 429`, Number.isFinite(after) && after > 0 ? after * 1000 : null);
      }
      if (!response.ok) throw new SolanaRpcError(`${method}: HTTP ${response.status}`);
      const body = (await response.json()) as { result?: T; error?: { message?: string; code?: number } };
      if (body.error) throw new SolanaRpcError(`${method}: ${body.error.message ?? 'RPC error'}`, body.error.code);
      if (body.result === undefined) throw new SolanaRpcError(`${method}: empty result`);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return r.value;
  }

  async getMultipleAccounts(addresses: readonly string[]): Promise<(RpcAccount | null)[]> {
    if (addresses.length === 0) return [];
    const r = await this.call<{ value: ({ data: [string, string]; owner: string; lamports: number } | null)[] }>('getMultipleAccounts', [
      [...addresses],
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    return r.value.map((a) => (a ? { data: Buffer.from(a.data[0], 'base64'), owner: a.owner, lamports: a.lamports } : null));
  }

  async getAccount(address: string): Promise<RpcAccount | null> {
    return (await this.getMultipleAccounts([address]))[0] ?? null;
  }

  async getBalance(address: string): Promise<bigint> {
    const r = await this.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
    return BigInt(r.value);
  }

  async getTokenSupply(mint: string): Promise<{ amount: bigint; decimals: number }> {
    const r = await this.call<{ value: { amount: string; decimals: number } }>('getTokenSupply', [mint, { commitment: 'confirmed' }]);
    return { amount: BigInt(r.value.amount), decimals: r.value.decimals };
  }

  /**
   * Runs a transaction against the node without sending it. With `sigVerify`
   * off (the default) an unsigned transaction is accepted and its blockhash is
   * replaced with a fresh one.
   */
  async simulateTransaction(transactionBase64: string, options: { readonly sigVerify?: boolean } = {}): Promise<SimulationResult> {
    const r = await this.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>('simulateTransaction', [
      transactionBase64,
      { encoding: 'base64', commitment: 'confirmed', sigVerify: options.sigVerify ?? false, replaceRecentBlockhash: !(options.sigVerify ?? false) },
    ]);
    return { err: r.value.err ?? null, logs: r.value.logs ?? [], unitsConsumed: r.value.unitsConsumed ?? null };
  }
}
