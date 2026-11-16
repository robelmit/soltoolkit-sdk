# Fixtures

Accounts recorded from Solana mainnet, replayed by the unit tests so they need no network.

| File | What was recorded |
|---|---|
| `pumpfun-curve.json` | A pump.fun bonding curve still trading, with the global and fee-config accounts |
| `pumpfun-curve-pump-quoted.json` | A curve quoted in a token other than SOL (the adapter refuses it) |
| `pumpswap-pool.json` | A PumpSwap pool state as the PumpSwap SDK returns it |
| `pumpswap-accounts-token.json` | Every account one PumpSwap state read touches, for a classic SPL token |
| `pumpswap-accounts-token2022.json` | The same for a Token-2022 token, where the wallet holds the token |
| `meteora-dbc-pool.json` | A Meteora DBC pool on its curve, with its config |
| `meteora-dbc-pool-migrated.json` | A Meteora DBC pool that has migrated |

The `user` in every file is a test address, not the wallet the accounts were read for. In the two
`pumpswap-accounts-*` files the recording wallet was replaced after recording: its token-account
addresses were re-derived for the test address, and the owner field of the one token account it held
was rewritten to match. Everything else is as the chain returned it.
