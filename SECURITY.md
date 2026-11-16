# Security

This code builds and checks transactions that move people's money. Please treat a bug in it that way.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting instead: the **Security** tab of this repository, then **Report a vulnerability**. Include the package and version, what you expected, what happened, and a transaction or account address that shows it if you have one.

You will get an answer within three working days. A fix for anything that can lose funds is released before the report is made public, and you are credited unless you ask not to be.

## What counts

- `verify` or `verifyTransaction` in `@soltoolkit/launchpad-sdk` accepting a transaction that does something other than the quoted swap for the user's own wallet.
- A quote that differs from what the venue's program would pay.
- A safety check that reports a pass where the data was missing or unknown.
- Anything in the bots that lets one group read or change another group's settings.

## What this repo never does

- It never holds, asks for or logs a private key. The SDK returns unsigned transactions; your wallet signs.
- It never sends a transaction for you.
- The bots are read-only: they post information and never trade.

## Using it safely

- Always run `verifyTransaction` on the bytes you are about to sign, not on the object you built them from.
- Pin the versions of the venue SDKs. Launchpads change their programs; a new SDK version is a change to what gets signed.
- Use your own RPC endpoint for anything that matters. Public endpoints are rate-limited and can return stale state.
