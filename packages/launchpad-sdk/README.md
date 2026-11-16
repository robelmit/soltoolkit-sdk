# @soltoolkit/launchpad-sdk

One interface for trading tokens on Solana launchpads: **quote**, **build** an unsigned transaction, and **verify** the bytes before a wallet signs them.

| Venue | What it is | Buy | Sell |
|---|---|---|---|
| `pumpfun` | pump.fun bonding curve | yes | yes |
| `pumpswap` | PumpSwap, the AMM pump.fun tokens graduate to | yes | yes |
| `meteora-dbc` | Meteora Dynamic Bonding Curve (the curve behind launchpads such as Bags and Believe) | yes | yes |

The SDK never signs and never sends. It has no API key and no server: it reads the chain through the JSON-RPC endpoint you give it. It adds no fee of its own to the transaction.

## Install

```bash
npm i @soltoolkit/launchpad-sdk @solana/web3.js
```

Node 20 or newer.

## Use

```ts
import { createLaunchpads } from '@soltoolkit/launchpad-sdk';

const launchpads = createLaunchpads({ rpcUrl: 'https://api.mainnet-beta.solana.com' });
const user = wallet.publicKey.toBase58();

// 0.01 SOL of a token, 3 % slippage. The first venue that has the token answers.
const quote = await launchpads.quote({ side: 'buy', mint, amountIn: 10_000_000n, slippageBps: 300, user });
console.log(quote.venue, quote.outAmount, quote.minOutAmount, quote.venueFeeLamports);

// An unsigned transaction: a compute budget and the venue's swap, nothing else.
const { transaction } = await launchpads.buildTransaction(quote, user, { priorityFeeLamports: 100_000n });

// Where the signing happens, on the bytes about to be signed:
launchpads.verifyTransaction(transaction, quote, user); // throws when it is not this quote's swap

transaction.sign([wallet]); // your wallet, your key
// ...send it through your own RPC.
```

Amounts are `bigint` base units: lamports for a buy, raw token units for a sell. A sell is the same call with `side: 'sell'`.

A runnable version is in [`examples/quote-and-build`](../../examples/quote-and-build).

## Which venue answers

Without a venue, `quote` asks `pumpfun`, then `pumpswap`, then `meteora-dbc`.

- A venue that answers `NOT_ON_CURVE` (the token is not there) or `MIGRATED` (the curve is complete) hands over to the next one.
- Any other refusal is the answer and is thrown as it is. A failed RPC read is never taken to mean "not listed".
- When no venue has the token, `quote` throws `NoVenueError`; `error.attempts` says what each venue answered.

To ask one venue only: `launchpads.quote(request, 'pumpswap')`.

Meteora finds a pool by a program scan, which many public RPC nodes refuse. Pass the pool when you know it: `launchpads.quote({ ...request, pool })`.

## What `verifyTransaction` refuses

`verifyTransaction(transaction, quote, user, { maxPriorityFeeLamports? })` reads the transaction (an object, its bytes, or base64) and throws unless it is exactly the quoted swap for that wallet. It refuses:

- a fee payer other than the wallet, or any second signer;
- address lookup tables (accounts it cannot read from the bytes);
- a priority fee above the limit (default 0.01 SOL), a price with no compute unit limit, or any other compute-budget instruction;
- more than one swap, or a swap for another mint, amount or floor;
- any instruction that is not the venue's swap or the wallet's own token-account plumbing, including a plain SOL transfer.

`buildTransaction` runs the same check on what it built before returning it. Run it again on the signing side if the transaction crossed a network or a process boundary on the way: that is the case it is for.

## Errors

Every adapter throws `LaunchpadError` with a `venue` and a `code`:

| Code | Meaning |
|---|---|
| `NOT_ON_CURVE` | The token has no curve or pool on this venue |
| `MIGRATED` | The curve is complete; the token trades elsewhere now |
| `STATE_UNAVAILABLE` | The state could not be read, or is not the shape the adapter expects |
| `AMOUNT` | The amount or the slippage cannot be filled |
| `UNSUPPORTED` | A real pool this adapter does not trade (for example, not quoted in SOL) |

## One adapter by itself

Each venue is a class with the same three methods, if you want to assemble the transaction yourself:

```ts
import { COMPUTE_BUDGET_PROGRAM, PumpfunAdapter, SolanaRpc, decodeInstructions } from '@soltoolkit/launchpad-sdk';

const adapter = new PumpfunAdapter({ rpc: new SolanaRpc({ url }) });
const quote = await adapter.quote({ side: 'buy', mint, amountIn: 10_000_000n, slippageBps: 300, user });
const { instructions, computeUnits } = await adapter.build(quote, user);
// ...build your own transaction `tx` around `instructions`, then check the swap part:
const swapPart = decodeInstructions(tx).filter((ix) => ix.programId !== COMPUTE_BUDGET_PROGRAM);
adapter.verify(swapPart, quote, user);
```

A venue of your own implements `LaunchpadAdapter` and is passed in `createLaunchpads({ rpcUrl, adapters: { ... } })`.

## Limits

- Pools quoted in SOL only. Some pump.fun tokens are quoted in another token, on the curve and on PumpSwap after it; those are refused with `UNSUPPORTED`, and the message names the quote token.
- Meteora DBC pools that have migrated to an AMM are refused with `MIGRATED`; trade those on the AMM or through an aggregator.
- A quote is a snapshot. Build and sign soon after quoting; the floor in the transaction (`minOutAmount`) is what protects the wallet when the price moves.
- Launchpads change their programs. The live test below is how a change is caught.

## Tests

```bash
pnpm --filter @soltoolkit/launchpad-sdk test        # recorded mainnet accounts, no network
LIVE=1 pnpm --filter @soltoolkit/launchpad-sdk test:live
```

The live test reads mainnet and asks the node to simulate a buy on each venue with signature checks off. It finds a token on the pump.fun and Meteora curves and a funded wallet in the latest transactions of those programs, so it needs no setup. Nothing is signed and nothing is sent. Set `SOLANA_RPC_URL` to use your own endpoint; the public one throttles.

## Built on

[`@pump-fun/pump-sdk`](https://www.npmjs.com/package/@pump-fun/pump-sdk), [`@pump-fun/pump-swap-sdk`](https://www.npmjs.com/package/@pump-fun/pump-swap-sdk) and [`@meteora-ag/dynamic-bonding-curve-sdk`](https://www.npmjs.com/package/@meteora-ag/dynamic-bonding-curve-sdk) do the curve maths and build the swap instructions. This package puts one interface over them, picks the venue, and adds the check before signing.

## Licence

MIT
