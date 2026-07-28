/**
 * The customer half of a TagRail checkout: one plain XRPL payment to the core
 * vault carrying the merchant's destination tag. No reservation, no agent
 * choice, nothing Flare-specific on the XRPL side.
 *
 *   npm run pay -- <tag> [amountXRP]
 *
 * Funds a throwaway testnet wallet from the XRPL faucet unless XRPL_SEED is set.
 */
import { Client, Wallet } from "xrpl";
import { readLimits } from "./chain.js";

const tag = Number(process.argv[2]);
const amountXrp = process.argv[3] ?? "5";
if (!Number.isInteger(tag)) throw new Error("usage: npm run pay -- <tag> [amountXRP]");

const snap = await readLimits("coston2");
console.log(`\n  core vault ${snap.coreVaultAddress}  tag ${tag}  amount ${amountXrp} XRP`);

const client = new Client("wss://s.altnet.rippletest.net:51233");
await client.connect();

const wallet = process.env.XRPL_SEED
  ? Wallet.fromSeed(process.env.XRPL_SEED)
  : (await client.fundWallet()).wallet;
console.log(`  paying from ${wallet.address}`);

const prepared = await client.autofill({
  TransactionType: "Payment",
  Account: wallet.address,
  Destination: snap.coreVaultAddress,
  DestinationTag: tag,
  Amount: String(BigInt(Math.round(Number(amountXrp) * 1e6))),
});
const result = await client.submitAndWait(wallet.sign(prepared).tx_blob);
const meta = result.result.meta as any;
console.log(`  ${meta?.TransactionResult}  tx ${result.result.hash}\n`);
await client.disconnect();
