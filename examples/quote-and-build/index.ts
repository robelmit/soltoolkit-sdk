/**
 * Quote a launchpad token, build the unsigned transaction, check it, and ask
 * the node what it would do. Nothing is signed and nothing is sent.
 *
 *   pnpm --filter example-quote-and-build start <mint> [wallet] [lamports]
 *
 * `wallet` is the address the trade is quoted and built for. Give a wallet
 * that holds SOL to see the simulation run to the end; without one a fresh
 * address is used, the transaction is still built and checked, and the
 * simulation says the account does not exist.
 *
 * SOLANA_RPC_URL picks the endpoint (default: the public mainnet one).
 */

import { Keypair } from '@solana/web3.js';
import { LaunchpadError, NoVenueError, createLaunchpads } from '@soltoolkit/launchpad-sdk';

const [mint, walletArg, lamportsArg] = process.argv.slice(2);
if (!mint) {
  console.error('usage: pnpm --filter example-quote-and-build start <mint> [wallet] [lamports]');
  process.exit(1);
}
const user = walletArg ?? Keypair.generate().publicKey.toBase58();
const amountIn = BigInt(lamportsArg ?? '10000000'); // 0.01 SOL
const rpcUrl = process.env['SOLANA_RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';

const launchpads = createLaunchpads({ rpcUrl });

try {
  // 1. Quote. The first venue that has the token answers.
  const quote = await launchpads.quote({ side: 'buy', mint, amountIn, slippageBps: 300, user });
  console.log(`venue            ${quote.venue}`);
  console.log(`pay              ${quote.inAmount} lamports`);
  console.log(`receive          ${quote.outAmount} token units (at least ${quote.minOutAmount})`);
  console.log(`venue fee        ${quote.venueFeeLamports} lamports`);
  console.log(`price impact     ${quote.priceImpactBps === null ? 'not given by this venue' : `${quote.priceImpactBps} bps`}`);

  // 2. Build the unsigned transaction.
  const built = await launchpads.buildTransaction(quote, user, { priorityFeeLamports: 100_000n });
  console.log(`transaction      ${built.transaction.serialize().length} bytes, ${built.computeUnits} compute units, blockhash ${built.recentBlockhash}`);

  // 3. Check the bytes, as the signing side would. Throws when they are not this quote's swap.
  launchpads.verifyTransaction(built.base64, quote, user);
  console.log('verified         the bytes are the quoted swap for this wallet and nothing else');

  // 4. Ask the node. Signature checks are off, so no key is needed and nothing can land.
  const simulation = await launchpads.rpc.simulateTransaction(built.base64, { sigVerify: false });
  console.log(`simulation       ${simulation.err ? `failed: ${JSON.stringify(simulation.err)}` : `ok, ${simulation.unitsConsumed} compute units`}`);
  if (simulation.err && !walletArg) console.log('                 (a fresh address holds no SOL; pass a funded wallet as the second argument)');

  // To trade for real: transaction.sign([yourKeypair]) and send it through your own RPC.
} catch (error) {
  if (error instanceof NoVenueError) {
    console.error(`No venue has ${mint}:`);
    for (const attempt of error.attempts) console.error(`  ${attempt.venue}: ${attempt.code}`);
  } else if (error instanceof LaunchpadError) {
    console.error(`${error.venue} refused (${error.code}): ${error.message}`);
  } else {
    throw error;
  }
  process.exitCode = 1;
}
