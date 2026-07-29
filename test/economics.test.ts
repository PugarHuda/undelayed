import { test } from "node:test";
import assert from "node:assert/strict";
import { attempt, breakEvenWinRate, payingPayment, COSTON2_MEASURED, type ExecutorCosts } from "../src/economics.js";
import type { FeeConfig } from "../src/fees.js";

const XRP = 1_000_000n;
const COSTON2: FeeConfig = { feeBips: 25n, minimumFeeUba: XRP / 10n, executorFeeUba: XRP / 10n };

/** Measured gas, with prices a demo can defend: FLR ~$0.02, XRP ~$1.06. */
const costs: ExecutorCosts = { ...COSTON2_MEASURED, nativeUsd: 0.02, xrpUsd: 1.06 };

test("a win pays, and a loss still costs the attestation", () => {
  const a = attempt(7n * XRP, COSTON2, costs);
  assert.equal(a.revenueUba, XRP / 10n);
  // 0.1 XRP at $1.06
  assert.ok(Math.abs(a.revenueUsd - 0.106) < 1e-9, `${a.revenueUsd}`);
  // (82947 + 356375) * 650 gwei * $0.02 — about half a cent
  assert.ok(a.winCostUsd > 0.005 && a.winCostUsd < 0.006, `${a.winCostUsd}`);
  // losing costs only the request, so it is the cheaper mistake
  assert.ok(a.lossCostUsd < a.winCostUsd, "a loss must cost less than a win");
  assert.ok(a.winMarginUsd > 0, "at these prices, winning pays");
});

test("revenue is the fee actually paid, not the setting", () => {
  // 0.15 XRP: the system fee takes 0.1 and the executor gets what is left
  assert.equal(attempt(150_000n, COSTON2, costs).revenueUba, 50_000n);
  // at the minimum fee exactly, the executor earns nothing at all
  assert.equal(attempt(100_000n, COSTON2, costs).revenueUba, 0n);
});

test("gas that outruns the fee makes every payment unprofitable", () => {
  // the executor fee is capped, so a high enough gas price kills the whole
  // business rather than just the small payments
  const dear = { ...costs, gasPriceWei: 650_000_000_000n * 1000n };
  assert.equal(payingPayment(COSTON2, dear), null);
  assert.equal(breakEvenWinRate(7n * XRP, COSTON2, dear), null);
});

test("below some payment size a win does not cover its own gas", () => {
  // squeeze the margin until only near-full executor fees pay
  const tight = { ...costs, nativeUsd: 0.02 * 17 }; // win cost ~ $0.095 vs $0.106 revenue
  const floor = payingPayment(COSTON2, tight);
  assert.notEqual(floor, null);
  assert.ok(floor! > COSTON2.minimumFeeUba, "the floor sits above the minimum fee");
  assert.ok(attempt(floor!, COSTON2, tight).winMarginUsd >= 0, "the floor itself pays");
  assert.ok(attempt(floor! - 1000n, COSTON2, tight).winMarginUsd < 0, "and one step below does not");
});

test("the break-even win rate is a fraction, and rises as margins thin", () => {
  const wide = breakEvenWinRate(7n * XRP, COSTON2, costs)!;
  assert.ok(wide > 0 && wide < 1, `${wide}`);
  assert.ok(wide < 0.05, "with 20x margins almost any win rate works");

  const thin = breakEvenWinRate(7n * XRP, COSTON2, { ...costs, nativeUsd: 0.02 * 15 })!;
  assert.ok(thin > wide, "thinner margins demand a higher win rate");
  assert.ok(thin < 1, `${thin}`);
});

test("the formula agrees with a direct expected-value calculation", () => {
  const w = breakEvenWinRate(7n * XRP, COSTON2, costs)!;
  const a = attempt(7n * XRP, COSTON2, costs);
  const ev = w * a.winMarginUsd - (1 - w) * a.lossCostUsd;
  assert.ok(Math.abs(ev) < 1e-12, `expected value at break-even should be zero, got ${ev}`);
});
