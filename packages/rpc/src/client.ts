/**
 * A small Solana JSON-RPC client.
 *
 * Public RPC endpoints throttle hard, and a tool that reads a few dozen
 * accounts hits the limit at once. So the client paces its own calls and
 * retries the answers that mean "later" (HTTP 429, 5xx, a timeout, a dropped
 * connection). An error the node gives for the request itself is never
 * retried: asking again would get the same answer.
 *
 * A failed read is always an error. It is never turned into "not found".
 */

/** The node answered the request with a JSON-RPC error. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'RpcError';
  }
}

/** The endpoint could not be reached, or kept answering "later" until the retries ran out. */
export class RpcUnavailable extends RpcError {
  constructor(
    method: string,
    message: string,
    readonly attempts: number,
  ) {
    super(method, null, message);
    this.name = 'RpcUnavailable';
  }
}

/**
 * The answer was larger than the client will read. Asking again would get the
 * same answer, so the call is not retried: narrow the request, or raise
 * `maxResponseBytes`.
 */
export class RpcAnswerTooLarge extends RpcError {
  constructor(
    method: string,
    readonly limitBytes: number,
  ) {
    super(method, null, `the answer is larger than ${limitBytes} bytes`);
    this.name = 'RpcAnswerTooLarge';
  }
}

/**
 * Limits for one call, in place of the client's own. A scan is the usual
 * reason: one large call that deserves a longer wait and no second try.
 */
export interface CallOptions {
  /** How long one attempt may take. */
  readonly timeoutMs?: number;
  /** How many times the call is tried again when throttled or lost in transit. */
  readonly retries?: number;
  /** The largest answer read, in bytes. */
  readonly maxResponseBytes?: number;
}

/**
 * Anything that can make a JSON-RPC call. `createRpc` returns one; so does any
 * client with the same method. A client of your own may ignore `options`: its
 * own limits then apply.
 */
export interface Rpc {
  call<T = unknown>(method: string, params: unknown[], options?: CallOptions): Promise<T>;
}

export interface RpcOptions {
  /** The JSON-RPC endpoint. */
  readonly url: string;
  /** Calls a second, at most. Default 4, a pace for public endpoints; raise it on your own node. 0 turns pacing off. */
  readonly requestsPerSecond?: number;
  /** How many times a call that was throttled or failed in transit is tried again. Default 4. */
  readonly retries?: number;
  /** How long one attempt may take. Default 15 seconds. */
  readonly timeoutMs?: number;
  /**
   * The largest answer the client reads, in bytes. Default 64 MiB. A scan can
   * answer with hundreds of megabytes; past this size the read stops and the
   * call fails with `RpcAnswerTooLarge`.
   */
  readonly maxResponseBytes?: number;
  /** Extra HTTP headers, for an endpoint that takes its key in a header. */
  readonly headers?: Readonly<Record<string, string>>;
  /** For tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** For tests: how to wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RpcClient extends Rpc {
  /** How many HTTP requests were sent, retries included. */
  readonly requests: number;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** HTTP 429 and JSON-RPC code 429 mean throttled; -32005 is a node that is behind or over its limit. */
const RETRY_RPC_CODES = new Set([429, -32005]);

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** The body as text, or `null` once it passes `limit` bytes. The rest of an oversized body is not downloaded. */
async function readText(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  const reader = response.body?.getReader();
  if (Number.isFinite(declared) && declared > limit) {
    await reader?.cancel().catch(() => undefined);
    return null;
  }
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function createRpc(options: RpcOptions): RpcClient {
  if (!options.url) throw new Error('createRpc needs a url');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const defaultRetries = options.retries ?? 4;
  const defaultTimeoutMs = options.timeoutMs ?? 15_000;
  const defaultMaxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const perSecond = options.requestsPerSecond ?? 4;
  const gapMs = perSecond > 0 ? 1000 / perSecond : 0;

  let id = 0;
  let requests = 0;
  /** When the next request may start. Requests take their turn in the order they were made. */
  let nextStart = 0;

  async function turn(): Promise<void> {
    if (gapMs === 0) return;
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + gapMs;
    if (start > now) await sleep(start - now);
  }

  async function once(
    method: string,
    params: unknown[],
    timeoutMs: number,
    maxBytes: number,
  ): Promise<{ ok: true; result: unknown } | { ok: false; retry: boolean; code: number | null; message: string; waitMs?: number; tooLarge?: true }> {
    await turn();
    requests += 1;
    id += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        return { ok: false, retry: true, code: response.status, message: `HTTP ${response.status}`, ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { waitMs: retryAfter * 1000 } : {}) };
      }
      if (!response.ok) return { ok: false, retry: false, code: response.status, message: `HTTP ${response.status}` };

      const text = await readText(response, maxBytes);
      if (text === null) return { ok: false, retry: false, code: null, message: 'the answer is too large', tooLarge: true };
      const body = JSON.parse(text) as { result?: unknown; error?: { code?: number; message?: string } };
      if (body.error) {
        const code = typeof body.error.code === 'number' ? body.error.code : null;
        return { ok: false, retry: code !== null && RETRY_RPC_CODES.has(code), code, message: body.error.message ?? 'JSON-RPC error' };
      }
      if (!('result' in body)) return { ok: false, retry: false, code: null, message: 'The answer has no result' };
      return { ok: true, result: body.result };
    } catch (error) {
      // A timeout, a reset connection or a body that is not JSON: the request may never have been answered.
      const message = controller.signal.aborted ? `no answer in ${timeoutMs} ms` : error instanceof Error ? error.message : String(error);
      return { ok: false, retry: true, code: null, message };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get requests() {
      return requests;
    },
    async call<T = unknown>(method: string, params: unknown[], callOptions: CallOptions = {}): Promise<T> {
      const retries = callOptions.retries ?? defaultRetries;
      const maxBytes = callOptions.maxResponseBytes ?? defaultMaxBytes;
      let last = 'no attempt made';
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const answer = await once(method, params, callOptions.timeoutMs ?? defaultTimeoutMs, maxBytes);
        if (answer.ok) return answer.result as T;
        if (answer.tooLarge) throw new RpcAnswerTooLarge(method, maxBytes);
        if (!answer.retry) throw new RpcError(method, answer.code, answer.message);
        last = answer.message;
        if (attempt < retries) await sleep(answer.waitMs ?? Math.min(8000, 500 * 2 ** attempt));
      }
      throw new RpcUnavailable(method, `${last} (after ${retries + 1} attempts)`, retries + 1);
    },
  };
}

/**
 * Stops a job after a set number of calls.
 *
 * For a walk whose size is not known in advance (a holder map, a wallet's
 * history): the job reads until the budget is spent, then reports what it has
 * as partial. `spent` and `left` say where it stands.
 */
export class RpcBudgetSpent extends Error {
  constructor(readonly budget: number) {
    super(`The budget of ${budget} RPC calls is spent`);
    this.name = 'RpcBudgetSpent';
  }
}

export interface BudgetedRpc extends Rpc {
  readonly spent: number;
  readonly left: number;
}

export function withBudget(rpc: Rpc, budget: number): BudgetedRpc {
  let spent = 0;
  return {
    get spent() {
      return spent;
    },
    get left() {
      return Math.max(0, budget - spent);
    },
    call<T = unknown>(method: string, params: unknown[], options?: CallOptions): Promise<T> {
      if (spent >= budget) return Promise.reject(new RpcBudgetSpent(budget));
      spent += 1;
      return rpc.call<T>(method, params, options);
    },
  };
}
