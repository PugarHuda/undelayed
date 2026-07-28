import { readLimits, ask, capacityUba, type Network } from "./chain.js";
import { advance } from "./limiter.js";
import { comparePlans } from "./plan.js";

const XRP = 1_000_000n; // UBA per XRP (6 drops decimals)

const fmt = (uba: bigint) =>
  (Number(uba) / Number(XRP)).toLocaleString("en-US", { maximumFractionDigits: 6 });
const ts = (t: bigint) => new Date(Number(t) * 1000).toISOString().replace("T", " ").slice(0, 19);
const dur = (s: bigint) => {
  if (s === 0n) return "now";
  const n = Number(s);
  const [h, m, sec] = [Math.floor(n / 3600), Math.floor((n % 3600) / 60), n % 60];
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
};

const network = (process.argv[2] ?? "coston2") as Network;
const amountXrp = process.argv[3] ?? "1000";
const amountUba = BigInt(Math.round(Number(amountXrp) * Number(XRP)));

const snap = await readLimits(network);
const g = snap.granularityUba;

console.log(`\n  ${network}  AssetManagerFXRP ${snap.assetManager}`);
console.log(`  chain time ${ts(snap.now)} UTC   core vault ${snap.coreVaultAddress}\n`);

for (const [name, l] of [
  ["hourly", snap.hourly],
  ["daily", snap.daily],
] as const) {
  const eff = advance(l, snap.now);
  const stale = eff.windowStart !== l.windowStart;
  console.log(
    `  ${name.padEnd(6)} limit ${fmt(l.maxPerWindow * g).padStart(9)} XRP` +
      `   on-chain reads ${fmt(l.minted * g).padStart(9)} used` +
      `   actually ${fmt(eff.minted * g).padStart(9)} used` +
      (stale ? `   <- window rolled ${dur(snap.now - l.windowStart)} ago` : ""),
  );
}

const cap = capacityUba(snap, snap.now);
console.log(`\n  largest mint that executes immediately: ${fmt(cap)} XRP`);
console.log(
  `  large-mint threshold ${fmt(snap.largeThresholdAmg * g)} XRP` +
    ` -> always delayed ${dur(snap.largeDelaySeconds)}, and never consumes window quota\n`,
);

const a = ask(snap, amountUba);
console.log(
  `  minting ${fmt(amountUba)} XRP now: ` +
    (a.delayed
      ? `DELAYED by ${a.reason} until ${ts(a.allowedAt)} UTC (wait ${dur(a.waitSeconds)})`
      : `executes immediately`),
);
if (a.delayed && !a.consumesWindowQuota) {
  console.log(`  (retrying before ${ts(a.allowedAt)} reverts DirectMintingStillDelayed)`);
}

if (a.delayed) {
  const c = comparePlans(snap, amountUba / g, snap.now);
  console.log(`\n  split into ${c.split.chunks.length} payments instead:`);
  for (const [i, ch] of c.split.chunks.entries()) {
    console.log(
      `    ${String(i + 1).padStart(2)}. ${fmt(ch.amountAmg * g).padStart(14)} XRP  ` +
        (ch.delayed ? `at ${ts(ch.allowedAt)} UTC` : "immediately"),
    );
  }
  console.log(
    c.splitWins
      ? `  first XRP arrives ${dur(c.firstArrivalSaved)} sooner, and the tail lands no later.`
      : `  but the tail then lands ${dur(c.split.lastAt - c.single.lastAt)} later than one payment` +
        ` — splitting is not free here.`,
  );
}
console.log();
