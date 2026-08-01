import { test } from "node:test";
import assert from "node:assert/strict";
import { estimate, checkoutLine, FLOOR_SECONDS, type EstimateInput } from "../src/estimate.js";

const XRP = 1_000_000n;
const NOW = 1_800_000_000n;

/** Coston2's shape: 100k hourly, 500k daily, 100k large threshold, 1h delay. */
const snap = (over: Partial<EstimateInput> = {}): EstimateInput => ({
  hourly: { windowSizeSeconds: 3600n, maxPerWindow: 100_000n * XRP, windowStart: NOW - 600n, minted: 0n },
  daily: { windowSizeSeconds: 86400n, maxPerWindow: 500_000n * XRP, windowStart: NOW - 600n, minted: 0n },
  largeThresholdAmg: 100_000n * XRP,
  largeDelaySeconds: 3600n,
  granularityUba: 1n,
  fees: { feeBips: 25n, minimumFeeUba: XRP / 10n, executorFeeUba: XRP / 10n },
  now: NOW,
  ...over,
});

test("an undelayed payment still is not instant, and does not claim to be", () => {
  const e = estimate(snap(), 25n * XRP);
  assert.equal(e.reason, "none");
  assert.equal(e.seconds, FLOOR_SECONDS, "the FDC round trip is not free");
  assert.match(e.text, /few minutes/);
  assert.equal(e.rejected, false);
});

test("a large minting is quoted past its protocol delay, not at it", () => {
  const e = estimate(snap(), 150_000n * XRP);
  assert.equal(e.reason, "large");
  assert.equal(e.seconds, 3600n + FLOOR_SECONDS);
  // an hour plus two and a half minutes must not be described as "within the hour"
  assert.match(e.text, /about 2 hours/);
});

test("the estimate never rounds down", () => {
  // 3601s + floor -> 3751s, which is 1.04 hours. Saying "about 1 hour" would
  // have the customer waiting past a promise that already expired.
  const e = estimate(snap({ largeDelaySeconds: 3601n }), 150_000n * XRP);
  assert.ok(e.seconds > 3600n);
  assert.match(e.text, /about 2 hours/);
});

test("a payment below the minimum fee is a rejection, not a wait", () => {
  const e = estimate(snap(), 50_000n);
  assert.equal(e.rejected, true);
  assert.equal(e.seconds, 0n);
  assert.match(e.text, /mint nothing/);
  assert.equal(e.netUba, 0n, "nothing is credited, so nothing is promised");
});

test("a bound hourly limit is named as the reason", () => {
  const e = estimate(snap({
    hourly: { windowSizeSeconds: 3600n, maxPerWindow: 100_000n * XRP, windowStart: NOW - 600n, minted: 99_999n * XRP },
  }), 5_000n * XRP);
  assert.equal(e.reason, "hourly");
  assert.ok(e.seconds > FLOOR_SECONDS, "a bound limit has to add time");
});

test("the checkout line says the amount, the wait and the reason", () => {
  const line = checkoutLine(snap(), 25n * XRP);
  assert.match(line, /24\.8 FXRP/, "the credited amount, not the amount sent");
  assert.match(line, /arrives/);
  assert.doesNotMatch(line, /limit is binding/, "nothing is binding here");

  const big = checkoutLine(snap(), 150_000n * XRP);
  assert.match(big, /large mintings are delayed by protocol/);
});

test("the estimate uses chain time, so a fast local clock cannot shorten it", () => {
  // Same payment, snapshot taken a minute earlier: the delay is measured from
  // the snapshot's own `now`, so the answer does not drift with the caller.
  const a = estimate(snap(), 150_000n * XRP);
  const b = estimate(snap({ now: NOW - 60n }), 150_000n * XRP);
  assert.equal(a.seconds, b.seconds);
});
