# soltoolkit-sdk

One interface for trading tokens on Solana launchpads, from the team behind the Hexa trading terminal. Quote, build an unsigned transaction, and verify the bytes before a wallet signs.

## Packages

| Package | What it does |
|---|---|
| [`@soltoolkit/launchpad-sdk`](packages/launchpad-sdk) | One interface for pump.fun, PumpSwap and Meteora DBC: `quote`, `build`, and `verify`, which re-reads the built transaction and refuses anything that is not the quoted swap for the user's own wallet |
| [`@soltoolkit/rpc`](packages/rpc) | The small JSON-RPC client the soltoolkit packages share: paced, retrying, size-capped, with base58 and program-derived addresses. No dependencies |

```bash
pnpm --filter example-quote-and-build start <mint>   # quote, build, verify and simulate a buy
```

## Principles

- **Nothing here signs, sends or holds a key.**
- **Unknown is never zero.** A value that could not be read stays `null`; it is never counted as a pass or as nothing.
- **Refuse rather than guess.** A failed read is an error, not "not found".
- **No API key needed.** Everything runs against a plain Solana JSON-RPC endpoint you choose.

## Develop

Node 22.13 or newer and pnpm, to work on the repository. The published packages run on Node 20 or newer.

```bash
pnpm install
pnpm check        # build, typecheck, test, lint
```

```bash
LIVE=1 pnpm --filter @soltoolkit/launchpad-sdk test:live   # mainnet reads and simulation only
```

## The soltoolkit family

| Repository | What it holds |
|---|---|
| **soltoolkit-sdk** (this one) | Launchpad trade SDK and the shared RPC client |
| [soltoolkit-feed](https://github.com/robelmit/soltoolkit-feed) | The launch feed: a Rust indexer for launches, trades and migrations |
| [soltoolkit-insights](https://github.com/robelmit/soltoolkit-insights) | Token safety, holder maps and their viewer, wallet PnL, the trading-app registry |
| [soltoolkit-bots](https://github.com/robelmit/soltoolkit-bots) | Telegram and Discord community bots |
| [soltoolkit-agents](https://github.com/robelmit/soltoolkit-agents) | A read-only MCP server for AI agents, and an HTTP API |

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

[MIT](LICENSE)
