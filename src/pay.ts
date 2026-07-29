/**
 * The customer half of a TagRail checkout: one plain XRPL payment to the core
 * vault carrying the merchant's destination tag. No reservation, no agent
 * choice, nothing Flare-specific on the XRPL side.
 *
 *   npm run pay -- <tag> [amountXRP]     send this much
 *   npm run pay -- <tag> --net 25        make sure the merchant receives 25 XRP
 *   npm run pay -- <tag> --usd 25        …or 25 dollars of it, priced by the FTSO
 *   npm run pay -- <tag> --usd 25 --quote   print the invoice, send nothing
 *
 * The three are not the same number. A payment loses a system fee and an
 * executor fee on the way in, so a merchant who asks for exactly the sticker
 * price is underpaid on every single sale.
 *
 * Funds a throwaway testnet wallet from the XRPL faucet unless XRPL_SEED is set.
 */
import { Client, Wallet } from "xrpl";
import { readLimits, xrpUsd, ask } from "./chain.js";
import { fees, invoice, invoiceSplit, usdToUba } from "./fees.js";
import { comparePlans, splitAmounts } from "./plan.js";

const ARGS = process.argv.slice(2);
const flag = (name: string) => {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 ? ARGS[i + 1] : undefined;
};
const tag = Number(ARGS[0]);
const quoteOnly = ARGS.includes("--quote");
const netXrp = flag("net");
const usd = flag("usd");
const plainAmount = ARGS[1] && !ARGS[1].startsWith("--") ? ARGS[1] : undefined;
if (!Number.isInteger(tag)) {
  throw new Error("usage: npm run pay -- <tag> [amountXRP] [--net XRP] [--usd USD] [--quote]");
}

const XRP = 1_000_000n;
const show = (uba: bigint) => (Number(uba) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

const snap = await readLimits("coston2");

const wantSplit = ARGS.includes("--split");
/** How the planner would cut this gross amount, in UBA. */
const cut = (grossUba: bigint) =>
  splitAmounts(snap, grossUba / snap.granularityUba, snap.now).map((amg) => amg * snap.granularityUba);

let sendUba: bigint;
let priced = "";
// A net target has to be grossed up against the fees the payment will actually
// pay — which is a different number once it is split, because every piece is
// charged separately. Grossing up for one payment and then splitting underpays
// the merchant by exactly the fees nobody counted.
const grossFor = (wantUba: bigint) =>
  wantSplit ? invoiceSplit(wantUba, snap.fees, cut).paidUba : invoice(wantUba, snap.fees).paidUba;

if (usd !== undefined) {
  const price = await xrpUsd("coston2");
  if (price === null) throw new Error("no XRP/USD feed — refusing to guess a checkout price");
  const wantUba = usdToUba(Number(usd), price, snap.granularityUba);
  sendUba = grossFor(wantUba);
  priced = `$${usd} at ${price.toFixed(6)} USD/XRP = ${show(wantUba)} XRP to the merchant`;
} else if (netXrp !== undefined) {
  const wantUba = BigInt(Math.round(Number(netXrp) * 1e6));
  sendUba = grossFor(wantUba);
  priced = `${netXrp} XRP to the merchant`;
} else {
  sendUba = BigInt(Math.round(Number(plainAmount ?? "5") * 1e6));
}

// One payment, or the split the planner recommends. Everything below is
// reported over the pieces that will actually be sent, so the "merchant" line
// is the total the merchant is really credited rather than the total of a
// payment nobody is going to make.
const amounts = wantSplit ? cut(sendUba) : [sendUba];
const pieces = amounts.map((a) => fees(a, snap.fees));
const total = pieces.reduce(
  (a, p) => ({
    paidUba: a.paidUba + p.paidUba,
    mintingFeeUba: a.mintingFeeUba + p.mintingFeeUba,
    executorFeeUba: a.executorFeeUba + p.executorFeeUba,
    netUba: a.netUba + p.netUba,
  }),
  { paidUba: 0n, mintingFeeUba: 0n, executorFeeUba: 0n, netUba: 0n },
);

const small = pieces.findIndex((p) => p.tooSmall);
if (small >= 0) {
  throw new Error(
    `${show(amounts[small])} XRP is below the ${show(snap.fees.minimumFeeUba)} XRP minimum fee — the facet mints nothing for it`,
  );
}
const delay = ask(snap, amounts[0]);

console.log(`\n  core vault ${snap.coreVaultAddress}  tag ${tag}`);
if (priced) console.log(`  invoice     ${priced}`);
console.log(`  send        ${show(total.paidUba)} XRP${amounts.length > 1 ? ` in ${amounts.length} payments` : ""}`);
console.log(`   ├ system fee   ${show(total.mintingFeeUba)}${pieces.every((p) => p.mintingFeeUba === snap.fees.minimumFeeUba) ? "  (the minimum, not the percentage)" : ""}`);
console.log(`   ├ executor fee ${show(total.executorFeeUba)}${amounts.length > 1 ? `  (${amounts.length}x)` : ""}`);
console.log(`   └ merchant     ${show(total.netUba)} FXRP`);
console.log(
  delay.delayed
    ? `  execution   delayed ${delay.waitSeconds}s by the ${delay.reason} limit`
    : `  execution   allowed immediately`,
);

if (wantSplit) {
  const cmp = comparePlans(snap, sendUba / snap.granularityUba, snap.now);
  const one = fees(sendUba, snap.fees);
  console.log(`\n  split into ${amounts.length}: ${amounts.map(show).join(" + ")} XRP`);
  console.log(
    cmp.splitWins
      ? `  first FXRP arrives ${cmp.firstArrivalSaved}s sooner; the tail lands no later`
      : `  the planner says this does NOT win — one payment settles in full sooner`,
  );
  // Speed is not free. Each piece is charged separately, and the minimum system
  // fee applies per piece, so the planner's "no later" is only half the answer.
  const cost = total.mintingFeeUba + total.executorFeeUba;
  const oneCost = one.mintingFeeUba + one.executorFeeUba;
  console.log(
    `  fees ${show(oneCost)} -> ${show(cost)} XRP (${cost > oneCost ? "+" : ""}${show(cost - oneCost)}) — each piece is charged separately`,
  );
  // The plan assumes the pieces are recorded in this order. Order at the vault
  // is ours, order of execution is not — a competing executor finalising the
  // second piece first changes which one is delayed.
  console.log(`  the order below is the payer's; which piece executes first is the executor's\n`);
}

if (quoteOnly) {
  console.log("  --quote: nothing sent\n");
  process.exit(0);
}

const client = new Client("wss://s.altnet.rippletest.net:51233");
await client.connect();

const wallet = process.env.XRPL_SEED
  ? Wallet.fromSeed(process.env.XRPL_SEED)
  : (await client.fundWallet()).wallet;
console.log(`  paying from ${wallet.address}`);

for (const [i, amount] of amounts.entries()) {
  const prepared = await client.autofill({
    TransactionType: "Payment",
    Account: wallet.address,
    Destination: snap.coreVaultAddress,
    DestinationTag: tag,
    Amount: String(amount),
  });
  const result = await client.submitAndWait(wallet.sign(prepared).tx_blob);
  const meta = result.result.meta as any;
  const label = amounts.length > 1 ? `piece ${i + 1}/${amounts.length} ` : "";
  console.log(`  ${label}${meta?.TransactionResult}  ${show(amount)} XRP  tx ${result.result.hash}`);
  if (meta?.TransactionResult !== "tesSUCCESS") {
    console.log(`  stopping: a failed piece leaves the rest unsent on purpose\n`);
    break;
  }
}
console.log();
await client.disconnect();
