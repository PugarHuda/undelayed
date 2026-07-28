import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, record, predict, undelayedCapacity, type Limits } from "../src/limiter.js";

const HOUR = 3600n;
const DAY = 86400n;
const M = 1_000_000n; // 1 XRP in AMG (granularity 1 on Coston2)

// Coston2 live settings: 100k hourly, 500k daily, large threshold 100k / 1h.
const base = (over: Partial<Limits> = {}): Limits => ({
  hourly: { windowSizeSeconds: HOUR, maxPerWindow: 100_000n * M, windowStart: 0n, minted: 0n },
  daily: { windowSizeSeconds: DAY, maxPerWindow: 500_000n * M, windowStart: 0n, minted: 0n },
  largeThresholdAmg: 100_000n * M,
  largeDelaySeconds: HOUR,
  ...over,
});

test("elapsed windows subtract one whole limit each, not reset to zero", () => {
  const l = { windowSizeSeconds: HOUR, maxPerWindow: 100n, windowStart: 0n, minted: 250n };
  assert.deepEqual(advance(l, HOUR), { ...l, minted: 150n, windowStart: HOUR });
  assert.deepEqual(advance(l, 2n * HOUR), { ...l, minted: 50n, windowStart: 2n * HOUR });
  assert.deepEqual(advance(l, 3n * HOUR), { ...l, minted: 0n, windowStart: 3n * HOUR });
});

test("stale on-chain state is not real usage", () => {
  // what the getter returns after a quiet day
  const l = { windowSizeSeconds: DAY, maxPerWindow: 500n, windowStart: 0n, minted: 480n };
  assert.equal(advance(l, DAY + 1n).minted, 0n);
});

test("landing exactly on the limit is already delayed", () => {
  const l = { windowSizeSeconds: HOUR, maxPerWindow: 100n, windowStart: 0n, minted: 40n };
  assert.equal(record(l, 59n, 10n).delayed, false);
  const r = record(l, 60n, 10n);
  assert.equal(r.delayed, true);
  assert.equal(r.allowedAt, HOUR); // windowStart + size * 100/100
});

test("overspend spills proportionally into later windows", () => {
  const l = { windowSizeSeconds: HOUR, maxPerWindow: 100n, windowStart: 0n, minted: 0n };
  // 5x the limit is not "wait for the next window", it is ~5 windows
  assert.equal(record(l, 500n, 0n).allowedAt, 5n * HOUR);
});

test("a large minting skips both limiters and consumes no quota", () => {
  const limits = base();
  const p = predict(limits, 100_000n * M, 1000n);
  assert.equal(p.reason, "large");
  assert.equal(p.allowedAt, 1000n + HOUR);
  assert.equal(p.consumesWindowQuota, false);
  // one AMG below the threshold takes the ordinary path, where on a fresh
  // window it still fits under the (equal) hourly limit and is not delayed
  assert.equal(predict(limits, 100_000n * M - 1n, 1000n).reason, "none");
});

test("the daily limiter can bind past the hourly one", () => {
  const limits = base({
    hourly: { windowSizeSeconds: HOUR, maxPerWindow: 100_000n * M, windowStart: 0n, minted: 0n },
    daily: { windowSizeSeconds: DAY, maxPerWindow: 500_000n * M, windowStart: 0n, minted: 499_000n * M },
  });
  const p = predict(limits, 90_000n * M, 60n);
  assert.equal(p.reason, "daily");
  assert.equal(p.allowedAt, (DAY * 589_000n) / 500_000n);
});

test("undelayed capacity respects the tightest of the three rules", () => {
  assert.equal(undelayedCapacity(base(), 0n), 100_000n * M - 1n); // large threshold binds
  const nearlyFull = base({
    hourly: { windowSizeSeconds: HOUR, maxPerWindow: 100_000n * M, windowStart: 0n, minted: 99_999n * M },
  });
  assert.equal(undelayedCapacity(nearlyFull, 0n), 1n * M - 1n);
  const full = base({
    hourly: { windowSizeSeconds: HOUR, maxPerWindow: 100_000n * M, windowStart: 0n, minted: 100_000n * M },
  });
  assert.equal(undelayedCapacity(full, 0n), 0n);
});

test("capacity found by the simulator is actually undelayed", () => {
  const limits = base({
    hourly: { windowSizeSeconds: HOUR, maxPerWindow: 100_000n * M, windowStart: 0n, minted: 40_000n * M },
    daily: { windowSizeSeconds: DAY, maxPerWindow: 500_000n * M, windowStart: 0n, minted: 470_000n * M },
  });
  const cap = undelayedCapacity(limits, 60n);
  assert.equal(predict(limits, cap, 60n).delayed, false);
  assert.equal(predict(limits, cap + 1n, 60n).delayed, true);
});
