import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  RpcAnswerTooLarge,
  RpcBudgetSpent,
  RpcError,
  RpcUnavailable,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  addressBytes,
  associatedTokenAddress,
  base58Decode,
  base58Encode,
  createRpc,
  findProgramAddress,
  isAddress,
  isOnCurve,
  withBudget,
} from '../src/index';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('base58', () => {
  it('round-trips known addresses', () => {
    for (const address of [USDC, TOKEN_PROGRAM, '11111111111111111111111111111111', 'So11111111111111111111111111111111111111112']) {
      const bytes = base58Decode(address);
      expect(bytes.length).toBe(32);
      expect(base58Encode(bytes)).toBe(address);
      expect(Buffer.from(bytes).equals(new PublicKey(address).toBuffer())).toBe(true);
    }
  });

  it('agrees with web3.js on random bytes, leading zeros included', () => {
    for (let i = 0; i < 300; i += 1) {
      const bytes = new Uint8Array(randomBytes(32));
      if (i % 10 === 0) bytes[0] = 0;
      if (i % 50 === 0) bytes[1] = 0;
      const text = base58Encode(bytes);
      expect(text).toBe(new PublicKey(bytes).toBase58());
      expect(Buffer.from(base58Decode(text)).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it('encodes other lengths (a 64-byte signature) and the empty value', () => {
    const signature = new Uint8Array(randomBytes(64));
    expect(Buffer.from(base58Decode(base58Encode(signature))).equals(Buffer.from(signature))).toBe(true);
    expect(base58Encode(new Uint8Array())).toBe('');
    expect(base58Decode('').length).toBe(0);
  });

  it('refuses text that is not base58 or not an address', () => {
    expect(() => base58Decode('0OIl')).toThrow(/Not base58/);
    expect(() => addressBytes('abc')).toThrow(/Not a Solana address/);
    expect(isAddress(USDC)).toBe(true);
    expect(isAddress('not an address')).toBe(false);
    expect(isAddress('abc')).toBe(false);
    expect(isAddress(`${USDC}1`)).toBe(false);
  });
});

describe('program-derived addresses', () => {
  it('tells curve points from other bytes as web3.js does', () => {
    let on = 0;
    for (let i = 0; i < 400; i += 1) {
      const bytes = new Uint8Array(randomBytes(32));
      const expected = PublicKey.isOnCurve(bytes);
      expect(isOnCurve(bytes)).toBe(expected);
      if (expected) on += 1;
    }
    // About half of all 32-byte values are points; a test that only saw one kind would prove little.
    expect(on).toBeGreaterThan(100);
    expect(on).toBeLessThan(300);
    expect(isOnCurve(new Uint8Array(31))).toBe(false);
  });

  it('derives the same address and bump as web3.js for random seeds', () => {
    const programs = [TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'];
    for (let i = 0; i < 60; i += 1) {
      const seeds = Array.from({ length: (i % 4) + 1 }, (_, n) => new Uint8Array(randomBytes(n === 0 ? 32 : (i % 31) + 1)));
      const program = programs[i % programs.length]!;
      const [expected, bump] = PublicKey.findProgramAddressSync(seeds, new PublicKey(program));
      expect(findProgramAddress(seeds, program)).toEqual({ address: expected.toBase58(), bump });
    }
  });

  it('takes a string seed as text', () => {
    const program = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), new PublicKey(program).toBuffer(), new PublicKey(USDC).toBuffer()], new PublicKey(program));
    expect(findProgramAddress(['metadata', addressBytes(program), addressBytes(USDC)], program).address).toBe(expected.toBase58());
  });

  it('derives associated token accounts for both token programs', () => {
    const owner = 'Em9VYusJCMEydDjFhNEvoN34hnHK6W9UPXEtNBxfWB9E';
    for (const tokenProgram of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const [expected] = PublicKey.findProgramAddressSync(
        [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(USDC).toBuffer()],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
      );
      expect(associatedTokenAddress(owner, USDC, tokenProgram)).toBe(expected.toBase58());
    }
  });

  it('refuses a seed over 32 bytes and more than 16 seeds', () => {
    expect(() => findProgramAddress([new Uint8Array(33)], TOKEN_PROGRAM)).toThrow(/at most 32 bytes/);
    expect(() => findProgramAddress(Array.from({ length: 17 }, () => 'a'), TOKEN_PROGRAM)).toThrow(/At most 16 seeds/);
  });
});

/** A fetch that answers from a list, and records what it was asked. */
function scripted(answers: Array<{ status?: number; body?: unknown; headers?: Record<string, string>; throws?: string }>) {
  const asked: Array<{ method: string; params: unknown[] }> = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    asked.push({ method: request.method, params: request.params });
    const answer = answers[Math.min(asked.length - 1, answers.length - 1)]!;
    if (answer.throws) throw new Error(answer.throws);
    return new Response(answer.body === undefined ? 'not json' : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: answer.headers ?? {} });
  }) as typeof globalThis.fetch;
  return { fetchImpl, asked };
}

function quiet() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe('createRpc', () => {
  it('needs a url', () => {
    expect(() => createRpc({ url: '' })).toThrow(/needs a url/);
  });

  it('returns the result and sends a JSON-RPC 2.0 request', async () => {
    const { fetchImpl, asked } = scripted([{ body: { jsonrpc: '2.0', id: 1, result: { value: 7 } } }]);
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, requestsPerSecond: 0 });
    expect(await rpc.call('getBalance', ['abc'])).toEqual({ value: 7 });
    expect(asked).toEqual([{ method: 'getBalance', params: ['abc'] }]);
    expect(rpc.requests).toBe(1);
  });

  it('keeps a null result as an answer, not as a failure', async () => {
    const { fetchImpl } = scripted([{ body: { jsonrpc: '2.0', id: 1, result: null } }]);
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, requestsPerSecond: 0 });
    expect(await rpc.call('getTransaction', ['sig'])).toBeNull();
  });

  it('retries a throttled call, waiting longer each time, then answers', async () => {
    const { fetchImpl } = scripted([{ status: 429, body: {} }, { status: 503, body: {} }, { body: { result: 'ok' } }]);
    const { waits, sleep } = quiet();
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, sleep, requestsPerSecond: 0 });
    expect(await rpc.call('getSlot', [])).toBe('ok');
    expect(waits).toEqual([500, 1000]);
    expect(rpc.requests).toBe(3);
  });

  it('waits as long as the endpoint asks in Retry-After', async () => {
    const { fetchImpl } = scripted([{ status: 429, body: {}, headers: { 'retry-after': '3' } }, { body: { result: 1 } }]);
    const { waits, sleep } = quiet();
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, sleep, requestsPerSecond: 0 });
    await rpc.call('getSlot', []);
    expect(waits).toEqual([3000]);
  });

  it('retries a throttle given as a JSON-RPC error, a dropped connection and a body that is not JSON', async () => {
    const { fetchImpl } = scripted([{ body: { error: { code: 429, message: 'Too many requests' } } }, { throws: 'socket hang up' }, {}, { body: { result: 5 } }]);
    const { sleep } = quiet();
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, sleep, requestsPerSecond: 0 });
    expect(await rpc.call('getSlot', [])).toBe(5);
    expect(rpc.requests).toBe(4);
  });

  it('gives up with RpcUnavailable when the endpoint never answers', async () => {
    const { fetchImpl } = scripted([{ status: 429, body: {} }]);
    const { sleep } = quiet();
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, sleep, retries: 2, requestsPerSecond: 0 });
    const error = await rpc.call('getSlot', []).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcUnavailable);
    expect(error).toMatchObject({ method: 'getSlot', attempts: 3 });
    expect(rpc.requests).toBe(3);
  });

  it('does not retry an error about the request itself', async () => {
    const { fetchImpl } = scripted([{ body: { error: { code: -32602, message: 'Invalid param: WrongSize' } } }]);
    const { waits, sleep } = quiet();
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, sleep, requestsPerSecond: 0 });
    const error = await rpc.call('getAccountInfo', ['x']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).not.toBeInstanceOf(RpcUnavailable);
    expect(error).toMatchObject({ code: -32602, method: 'getAccountInfo' });
    expect(waits).toEqual([]);
    expect(rpc.requests).toBe(1);
  });

  it('does not retry a refused request (HTTP 403) or an answer with no result', async () => {
    const refused = scripted([{ status: 403, body: {} }]);
    await expect(createRpc({ url: 'https://rpc.invalid', fetch: refused.fetchImpl, requestsPerSecond: 0 }).call('getSlot', [])).rejects.toMatchObject({ code: 403 });
    expect(refused.asked.length).toBe(1);

    const empty = scripted([{ body: { jsonrpc: '2.0', id: 1 } }]);
    await expect(createRpc({ url: 'https://rpc.invalid', fetch: empty.fetchImpl, requestsPerSecond: 0 }).call('getSlot', [])).rejects.toThrow(/no result/);
  });

  it('times out an attempt that gets no answer', async () => {
    const hanging = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof globalThis.fetch;
    const { sleep } = quiet();
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: hanging, sleep, timeoutMs: 20, retries: 1, requestsPerSecond: 0 });
    await expect(rpc.call('getSlot', [])).rejects.toThrow(/no answer in 20 ms/);
  });

  it('paces calls: the gap between starts is one second over the rate', async () => {
    const { fetchImpl } = scripted([{ body: { result: 1 } }]);
    const { waits, sleep } = quiet();
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, sleep, requestsPerSecond: 2 });
    await Promise.all([rpc.call('a', []), rpc.call('b', []), rpc.call('c', [])]);
    expect(waits.length).toBe(2);
    expect(waits[0]!).toBeGreaterThan(400);
    expect(waits[0]!).toBeLessThanOrEqual(500);
    expect(waits[1]!).toBeGreaterThan(900);
    expect(waits[1]!).toBeLessThanOrEqual(1000);
  });

  it('sends extra headers', async () => {
    let seen: Record<string, string> = {};
    const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen = init?.headers ?? {};
      return new Response(JSON.stringify({ result: 1 }));
    }) as typeof globalThis.fetch;
    await createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, headers: { 'x-token': 'abc' }, requestsPerSecond: 0 }).call('getSlot', []);
    expect(seen).toMatchObject({ 'content-type': 'application/json', 'x-token': 'abc' });
  });

  it('stops reading an answer past the size cap and does not ask again', async () => {
    const big = { result: 'x'.repeat(5_000) };
    const { fetchImpl, asked } = scripted([{ body: big }]);
    const { waits, sleep } = quiet();
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, sleep, maxResponseBytes: 1_000, requestsPerSecond: 0 });
    const error = await rpc.call('getProgramAccounts', ['program']).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcAnswerTooLarge);
    expect(error).toMatchObject({ method: 'getProgramAccounts', limitBytes: 1_000 });
    expect(asked.length).toBe(1);
    expect(waits).toEqual([]);
    // The same answer under a cap that fits it is read whole.
    const roomy = createRpc({ url: 'https://rpc.invalid', fetch: scripted([{ body: big }]).fetchImpl, maxResponseBytes: 10_000, requestsPerSecond: 0 });
    expect(await roomy.call<string>('getProgramAccounts', ['program'])).toHaveLength(5_000);
  });

  it('refuses an answer whose declared length is over the cap before reading it', async () => {
    let cancelled = false;
    const fetchImpl = (async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"result":'));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { 'content-length': '900000000' } });
    }) as typeof globalThis.fetch;
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, requestsPerSecond: 0 });
    await expect(rpc.call('getProgramAccounts', ['program'])).rejects.toBeInstanceOf(RpcAnswerTooLarge);
    expect(cancelled).toBe(true);
  });

  it('reads an answer that arrives in pieces, a multi-byte character split across two of them', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ result: 'né' }));
    const cut = bytes.indexOf(0xc3) + 1;
    const fetchImpl = (async () => {
      const parts = [bytes.slice(0, cut), bytes.slice(cut)];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const part = parts.shift();
          if (part) controller.enqueue(part);
          else controller.close();
        },
      });
      return new Response(body);
    }) as typeof globalThis.fetch;
    expect(await createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, requestsPerSecond: 0 }).call('getSlot', [])).toBe('né');
  });

  it('takes limits for one call in place of its own, and keeps its own for the next', async () => {
    // Retries: none for this call, although the client allows four.
    const throttled = scripted([{ status: 429, body: {} }]);
    const { waits, sleep } = quiet();
    const rpc = createRpc({ url: 'https://rpc.invalid', fetch: throttled.fetchImpl, sleep, requestsPerSecond: 0 });
    const error = await rpc.call('getProgramAccounts', ['program'], { retries: 0 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcUnavailable);
    expect(error).toMatchObject({ attempts: 1 });
    expect(throttled.asked.length).toBe(1);
    expect(waits).toEqual([]);
    await rpc.call('getSlot', []).catch(() => undefined);
    expect(throttled.asked.length).toBe(1 + 5);

    // Size: a smaller cap for one call.
    const big = scripted([{ body: { result: 'x'.repeat(5_000) } }]);
    const capped = createRpc({ url: 'https://rpc.invalid', fetch: big.fetchImpl, requestsPerSecond: 0 });
    await expect(capped.call('getProgramAccounts', ['program'], { maxResponseBytes: 1_000 })).rejects.toMatchObject({ limitBytes: 1_000 });
    expect(await capped.call<string>('getProgramAccounts', ['program'])).toHaveLength(5_000);

    // Time: a shorter wait for one call.
    const hanging = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof globalThis.fetch;
    const slow = createRpc({ url: 'https://rpc.invalid', fetch: hanging, sleep, requestsPerSecond: 0 });
    await expect(slow.call('getProgramAccounts', ['program'], { timeoutMs: 20, retries: 0 })).rejects.toThrow(/no answer in 20 ms/);
  });
});

describe('withBudget', () => {
  it('passes calls through until the budget is spent, then refuses without calling', async () => {
    const { fetchImpl, asked } = scripted([{ body: { result: 1 } }]);
    const rpc = withBudget(createRpc({ url: 'https://rpc.invalid', fetch: fetchImpl, requestsPerSecond: 0 }), 2);
    expect(rpc.left).toBe(2);
    await rpc.call('a', []);
    await rpc.call('b', []);
    expect(rpc.spent).toBe(2);
    expect(rpc.left).toBe(0);
    await expect(rpc.call('c', [])).rejects.toBeInstanceOf(RpcBudgetSpent);
    expect(asked.length).toBe(2);
  });

  it('hands the limits for one call on to the client', async () => {
    const seen: unknown[] = [];
    const inner = { call: async <T>(_method: string, _params: unknown[], options?: unknown) => (seen.push(options), 1 as T) };
    await withBudget(inner, 1).call('getProgramAccounts', [], { retries: 0 });
    expect(seen).toEqual([{ retries: 0 }]);
  });
});
