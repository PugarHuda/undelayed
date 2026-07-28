import { test } from "node:test";
import assert from "node:assert/strict";
import { comparePlans, splitAmounts } from "../src/plan.js";
import type { Limits } from "../src/limiter.js";

const HOUR = 3600n;
const DAY = 86400n;
const M = 1_000_000n;

// Coston2 live settings: 100k hourly, 500k daily, large threshold 100k / 1h.
const base = (over: Partial<Limits> = {}): Limits => ({
  hourly: { windowSizeSeconds: HOUR, maxPerWindow: 100_000n * M, windowStart: 0n, minted: 0n },
  daily: { windowSizeSeconds: DAY, maxPerWindow: 500_000n * M, windowStart: 0n, minted: 0n },
  largeThresholdAmg: 100_000n * M,
  largeDelaySeconds: HOUR,
  ...over,
});

test("splitting beats one payment when the amount is just over the cliff", () => {
  const limits = base();
  // 100,001 XRP as one payment is a large minting: flat 1h delay.
  const c = comparePlans(limits, 100_001n * M, 0n);
  assert.equal(c.single.chunks.length, 1);
  assert.equal(c.single.firstAt, HOUR);
  // Split: 99,999.999999 lands now, the remainder rides the ordinary limiter.
  assert.equal(c.split.firstAt, 0n);
  assert.equal(c.firstArrivalSaved, HOUR);
  assert.equal(c.splitWins, true);
});

test("splitting does not invent capacity — the tail still waits", () => {
  const limits = base();
  const c = comparePlans(limits, 300_000n * M, 0n);
  // first chunk immediate, but the full amount is not settled sooner than the
  // limiter allows: 300k against a 100k hourly limit is ~3 windows either way
  assert.equal(c.split.firstAt, 0n);
  assert.ok(c.split.lastAt >= 2n * HOUR, `lastAt ${c.split.lastAt}`);
});

test("splitting is reported as a loss when it is one", () => {
  // A large mint consumes no window quota; splitting forces it through the
  // limiter, which can settle the tail later than the flat large delay.
  const limits = base({
    hourly: { windowSizeSeconds: HOUR, maxPerWindow: 10_000n * M, windowStart: 0n, minted: 0n },
    largeThresholdAmg: 20_000n * M,
    largeDelaySeconds: 600n,
  });
  const c = comparePlans(limits, 60_000n * M, 0n);
  assert.equal(c.single.lastAt, 600n); // flat 10 minutes
  assert.ok(c.split.lastAt > c.single.lastAt, "split tail should be later");
  assert.equal(c.splitWins, false);
});

test("no chunk is ever at or above the large-mint threshold", () => {
  const limits = base();
  for (const total of [150_000n, 400_000n, 999_999n]) {
    for (const c of splitAmounts(limits, total * M, 0n)) {
      assert.ok(c < limits.largeThresholdAmg, `chunk ${c} crosses the cliff`);
    }
  }
});

test("chunks sum to the requested amount, and the cliff sets the piece count", () => {
  const limits = base();
  const total = 777_777n * M;
  const chunks = splitAmounts(limits, total, 0n);
  assert.equal(chunks.reduce((a, b) => a + b, 0n), total);
  // 777,777 under a 100k cliff cannot be fewer than 8 payments, however much
  // the caller would prefer four.
  assert.equal(chunks.length, 8);
});

test("an amount that already executes immediately is left alone", () => {
  const limits = base();
  const c = comparePlans(limits, 1_000n * M, 0n);
  assert.equal(c.single.firstAt, 0n);
  assert.equal(c.split.chunks.length, 1);
  assert.equal(c.splitWins, false); // nothing to win
});
