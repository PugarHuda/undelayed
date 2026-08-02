import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAligned, ask, capacityUba, type Snapshot } from "../src/chain.js";

const XRP = 1_000_000n;
const NOW = 1_800_000_000n;

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  hourly: { windowSizeSeconds: 3600n, maxPerWindow: 100_000n * XRP, windowStart: 1_799_996_400n, minted: 0n },
  daily: { windowSizeSeconds: 86400n, maxPerWindow: 500_000n * XRP, windowStart: 1_799_971_200n, minted: 0n },
  largeThresholdAmg: 100_000n * XRP,
  largeDelaySeconds: 3600n,
  assetManager: "0x0000000000000000000000000000000000000001",
  mintingTagManager: "0x0000000000000000000000000000000000000002",
  granularityUba: 1n,
  executorFeeUba: XRP / 10n,
  fees: { feeBips: 25n, minimumFeeUba: XRP / 10n, executorFeeUba: XRP / 10n },
  othersCanExecuteAfterSeconds: 7200n,
  coreVaultAddress: "rTest",
  now: NOW,
  ...over,
});

test("aligned windows pass", () => {
  assert.doesNotThrow(() => assertAligned(snap()));
});

test("a misaligned window start means the assumed window size is wrong", () => {
  // The contract aligns windowStart to the window size. If it is not a multiple
  // of what we assumed, our assumption is wrong — and every prediction after it
  // would be quietly wrong too.
  assert.throws(
    () => assertAligned(snap({ hourly: { windowSizeSeconds: 3600n, maxPerWindow: 1n, windowStart: 1_799_998_401n, minted: 0n } })),
    /not aligned to 3600s/,
  );
  assert.throws(
    () => assertAligned(snap({ daily: { windowSizeSeconds: 86400n, maxPerWindow: 1n, windowStart: 1n, minted: 0n } })),
    /not aligned to 86400s/,
  );
});

test("a zero window size is refused rather than dividing by it", () => {
  assert.throws(
    () => assertAligned(snap({ hourly: { windowSizeSeconds: 0n, maxPerWindow: 1n, windowStart: 0n, minted: 0n } })),
    /window size is zero/,
  );
});

test("ask reports the wait, not just the timestamp", () => {
  const clear = ask(snap(), 1_000n * XRP);
  assert.equal(clear.delayed, false);
  assert.equal(clear.waitSeconds, 0n, "an undelayed mint waits zero, not a negative number");

  const big = ask(snap(), 150_000n * XRP);
  assert.equal(big.delayed, true);
  assert.equal(big.reason, "large");
  assert.equal(big.waitSeconds, 3600n);
});

test("ask converts UBA to AMG, so granularity is not a silent units bug", () => {
  // With granularity 1000, a 150,000 XRP payment is 150 AMG — far below a
  // threshold expressed in AMG. Treating UBA as AMG would call it large.
  const coarse = snap({ granularityUba: 1000n, largeThresholdAmg: 100_000n * XRP });
  assert.equal(ask(coarse, 150_000n * XRP).delayed, false);
});

test("capacity is reported in UBA, whatever the granularity", () => {
  assert.equal(capacityUba(snap()), 99_999n * XRP + 999_999n);
  // Same headroom, coarser unit: the number in UBA is unchanged.
  const coarse = snap({
    granularityUba: 10n,
    hourly: { windowSizeSeconds: 3600n, maxPerWindow: 10_000n * XRP, windowStart: 1_799_996_400n, minted: 0n },
    daily: { windowSizeSeconds: 86400n, maxPerWindow: 50_000n * XRP, windowStart: 1_799_971_200n, minted: 0n },
    largeThresholdAmg: 10_000n * XRP,
  });
  assert.equal(capacityUba(coarse) % 10n, 0n, "capacity must be a whole number of AMG");
});
