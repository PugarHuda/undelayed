// onchain-status.mjs — proves TagRail's claims from public reads alone.
//
//   npm run status
//
// Anyone can run this against Coston2 and check the submission without asking us
// and without a private key. Every number the README and SUBMISSION quote about
// the rail comes from here.
//
// It reads through src/chain.ts rather than re-encoding the calls, which was the
// first attempt: hand-written selectors are a way to print a confident wrong
// number, and the first version did exactly that. This shares the reader the
// product uses, so if the script is right the product is too.
import { readLimits, capacityUba, ask, xrpUsd } from "../src/chain.js";
import { fees, invoice } from "../src/fees.js";
import { estimate } from "../src/estimate.js";
import { advance } from "../src/limiter.js";

const NET = process.argv[2] ?? "coston2";
const EXPLORER =
  NET === "flare" ? "https://flare-explorer.flare.network" : "https://coston2-explorer.flare.network";

// The transaction the submission leans on hardest: our own bot finalising a
// payment, split exactly as _computeFees says.
const WIN_TX = "0x595a419cde1614b7e912dacde0733b6be57d832fce1fea1f4595a26c5fd95e0f";

const XRP = 1_000_000n;
const xrp = (uba) => (Number(uba) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });
const line = (label, value) => console.log(`  ${String(label).padEnd(28)} ${value}`);

console.log(`\nUNDELAYED / TAGRAIL — on-chain status (${NET})\n`);

const snap = await readLimits(NET);
line("AssetManagerFXRP", `${snap.assetManager}  ${EXPLORER}/address/${snap.assetManager}`);
line("MintingTagManager", `${snap.mintingTagManager}  (Flare's own — we did not deploy it)`);
line("core vault (XRPL)", snap.coreVaultAddress);
line("chain time", new Date(Number(snap.now) * 1000).toISOString().slice(0, 19) + " UTC");

// 1. The fee model src/fees.ts encodes. If Flare change any of these, the
//    invoice maths is wrong and this is where you find out.
console.log("");
line("system fee", `${Number(snap.fees.feeBips) / 100}%, minimum ${xrp(snap.fees.minimumFeeUba)} XRP`);
line("executor fee", `${xrp(snap.fees.executorFeeUba)} XRP`);
const crossover = (snap.fees.minimumFeeUba * 10_000n) / snap.fees.feeBips;
console.log(
  `\n  Below ${xrp(crossover)} XRP the system fee is flat, above it a percentage.\n` +
    "  A merchant who invoices the sticker price is underpaid on every sale:\n",
);
const want = 25n * XRP;
const inv = invoice(want, snap.fees);
line("  to net 25 XRP, send", `${xrp(inv.paidUba)} XRP`);
line("  invoicing 25 XRP nets", `${xrp(fees(want, snap.fees).netUba)} XRP`);

// 2. The claim the whole product rests on: the stored window goes stale, so the
//    getter and reality disagree.
console.log("");
for (const [name, l] of [["hourly", snap.hourly], ["daily", snap.daily]]) {
  const eff = advance(l, snap.now);
  const stale = eff.windowStart !== l.windowStart;
  line(
    `${name} limit`,
    `${xrp(l.maxPerWindow * snap.granularityUba)} XRP — getter says ${xrp(l.minted * snap.granularityUba)} used, ` +
      `actually ${xrp(eff.minted * snap.granularityUba)}${stale ? "  <- STALE" : ""}`,
  );
}
line("largest immediate mint", `${xrp(capacityUba(snap))} XRP`);
line("large-mint threshold", `${xrp(snap.largeThresholdAmg * snap.granularityUba)} XRP, delayed ${snap.largeDelaySeconds}s`);
line("executor exclusivity", `${snap.othersCanExecuteAfterSeconds}s from the payment's own timestamp`);

// 3. What a customer would actually be told, right now.
console.log("");
const price = await xrpUsd(NET);
if (price) line("XRP/USD (FTSO)", `$${price.toFixed(6)}`);
for (const amount of [25n * XRP, 150_000n * XRP]) {
  const e = estimate(snap, amount);
  line(`paying ${xrp(amount)} XRP`, `${xrp(e.netUba)} FXRP ${e.text}`);
}
const a = ask(snap, 150_000n * XRP);
if (a.delayed) line("  reason", `${a.reason}, ${a.waitSeconds}s`);

// 4. And the receipt anyone can decode for themselves.
console.log("");
try {
  const res = await fetch(NET === "flare" ? "https://flare-api.flare.network/ext/C/rpc" : "https://coston2-api.flare.network/ext/C/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [WIN_TX] }),
  });
  const { result } = await res.json();
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const mints = (result?.logs ?? []).filter((l) => l.topics?.[0] === TRANSFER);
  if (mints.length) {
    line("our bot's winning tx", `${EXPLORER}/tx/${WIN_TX}`);
    for (const m of mints) line("  →", `${xrp(BigInt(m.data))} FXRP to 0x${m.topics[2].slice(-40)}`);
  }
} catch {
  line("winning tx", "receipt not readable from this RPC");
}

console.log(
  "\n  Every line above is a public read. No key, and no trust in our word — which\n" +
    "  is the point: the submission quotes these numbers, and this is how you\n" +
    "  check them.\n",
);
