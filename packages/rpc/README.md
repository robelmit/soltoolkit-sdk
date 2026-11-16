# @soltoolkit/rpc

A small Solana JSON-RPC client for tools that read the chain, plus the two helpers such tools always need: base58 and program-derived addresses.

It has no dependencies. The other `@soltoolkit` packages take an `Rpc` from here, so they all share one pace and one retry rule.

## Install

```bash
npm i @soltoolkit/rpc
```

Node 20 or newer.

## The client

```ts
import { createRpc } from '@soltoolkit/rpc';

const rpc = createRpc({ url: 'https://api.mainnet-beta.solana.com' });

const slot = await rpc.call<number>('getSlot', []);
const account = await rpc.call('getAccountInfo', [address, { encoding: 'jsonParsed' }]);
```

What it does for you:

- **Paces its own calls.** Four a second by default, which suits public endpoints. Set `requestsPerSecond` higher on your own node, or `0` to turn pacing off.
- **Retries the answers that mean "later":** HTTP 429 and 5xx, JSON-RPC codes 429 and -32005, a timeout, a dropped connection. It waits longer after each try, or as long as a `Retry-After` header says.
- **Never retries an answer about the request itself.** A bad parameter gets the same answer the second time.
- **Never turns a failed read into "not found".** A failure is thrown: `RpcError` when the node refused the request, `RpcUnavailable` when the endpoint could not be reached or stayed throttled.
- **Stops reading an answer that is too large.** A scan of a busy program can answer with hundreds of megabytes. Past `maxResponseBytes` the download stops and the call fails with `RpcAnswerTooLarge`, which is not retried.

| Option | Default | Meaning |
|---|---|---|
| `url` | required | The JSON-RPC endpoint |
| `requestsPerSecond` | `4` | Calls a second at most; `0` is no pacing |
| `retries` | `4` | Extra tries for a throttled or lost call |
| `timeoutMs` | `15000` | How long one try may take |
| `maxResponseBytes` | `67108864` (64 MiB) | The largest answer the client reads |
| `headers` | none | Extra HTTP headers, for an endpoint that takes its key in a header |

`rpc.requests` is the number of HTTP requests sent so far, retries included.

One call can take its own `timeoutMs`, `retries` and `maxResponseBytes` in place of the client's. A scan is the usual reason: one large call that deserves a longer wait and no second try.

```ts
const accounts = await rpc.call('getProgramAccounts', [program, config], { timeoutMs: 60_000, retries: 0 });
```

### The `Rpc` interface

```ts
interface Rpc {
  call<T = unknown>(method: string, params: unknown[], options?: CallOptions): Promise<T>;
}
```

Every `@soltoolkit` package accepts anything with this one method, so you can pass your own client. A client of your own may ignore `options`; its own limits then apply.

### A call budget

Some jobs do not know their size in advance: a holder map, a wallet's history. `withBudget` stops such a job after a set number of calls, so it can report what it has as partial.

```ts
import { RpcBudgetSpent, withBudget } from '@soltoolkit/rpc';

const limited = withBudget(rpc, 200);
try {
  await walk(limited);
} catch (error) {
  if (!(error instanceof RpcBudgetSpent)) throw error;
  // Out of budget: keep what was read, mark the result as partial.
}
console.log(limited.spent, limited.left);
```

## Addresses

```ts
import { associatedTokenAddress, findProgramAddress, isAddress, TOKEN_2022_PROGRAM } from '@soltoolkit/rpc';

isAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // true

// A program-derived address. A text seed is its UTF-8 bytes; an address seed is passed as bytes.
const { address, bump } = findProgramAddress(['pool_authority'], 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');

// A wallet's token account for a mint.
const usdcAccount = associatedTokenAddress(owner, mint);
const token2022Account = associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM);
```

Also exported: `base58Encode`, `base58Decode`, `addressBytes`, `isOnCurve`, and the program addresses `TOKEN_PROGRAM`, `TOKEN_2022_PROGRAM`, `ASSOCIATED_TOKEN_PROGRAM`, `SYSTEM_PROGRAM`.

The tests compare base58, the curve check and the derived addresses with `@solana/web3.js` on random inputs.

## Licence

MIT
