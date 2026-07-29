import { test } from "node:test";
import assert from "node:assert/strict";
import { fees, invoice, invoiceSplit, usdToUba, type FeeConfig } from "../src/fees.js";

const XRP = 1_000_000n;

/** Read off the live AssetManager, 28 July 2026. */
const COSTON2: FeeConfig = { feeBips: 25n, minimumFeeUba: XRP / 10n, executorFeeUba: XRP / 10n };
const FLARE: FeeConfig = { feeBips: 10n, minimumFeeUba: XRP / 10n, executorFeeUba: XRP / 5n };

test("it reproduces the split we actually observed on Coston2", () => {
  // tx 0x595a419c… : 7 XRP in, and the receipt shows three mints —
  // 0.1 to the fee receiver, 6.8 to the merchant, 0.1 to the executor.
  const b = fees(7n * XRP, COSTON2);
  assert.equal(b.mintingFeeUba, XRP / 10n);
  assert.equal(b.executorFeeUba, XRP / 10n);
  assert.equal(b.netUba, 6_800_000n);

  // and the earlier 5 XRP payment that landed as 4.8
  assert.equal(fees(5n * XRP, COSTON2).netUba, 4_800_000n);
});

test("the system fee is a floor on small baskets and a percentage on large ones", () => {
  // 25 bips of 7 XRP is 0.0175, so the 0.1 minimum wins
  assert.equal(fees(7n * XRP, COSTON2).mintingFeeUba, XRP / 10n);
  // 25 bips of 1000 XRP is 2.5, so the percentage wins
  assert.equal(fees(1000n * XRP, COSTON2).mintingFeeUba, 2_500_000n);
  // the crossover is exactly where relative == minimum: 0.1 / 0.0025 = 40 XRP
  assert.equal(fees(40n * XRP, COSTON2).mintingFeeUba, XRP / 10n);
  assert.equal(fees(40n * XRP + 1n, COSTON2).mintingFeeUba, XRP / 10n); // floor still ties
  assert.equal(fees(41n * XRP, COSTON2).mintingFeeUba, 102_500n);
});

test("the system fee is taken before the executor fee, and neither overdraws", () => {
  // a payment equal to the minimum fee: the system takes all of it, the
  // executor gets nothing, the merchant gets nothing — and it is not "too
  // small", because the facet compares with a strict <
  const atMin = fees(XRP / 10n, COSTON2);
  assert.equal(atMin.mintingFeeUba, XRP / 10n);
  assert.equal(atMin.executorFeeUba, 0n);
  assert.equal(atMin.netUba, 0n);
  assert.equal(atMin.tooSmall, false);

  // below it, the payment is rejected outright — a checkout that allows this
  // has taken the customer's XRP and minted nothing
  assert.equal(fees(XRP / 10n - 1n, COSTON2).tooSmall, true);

  // between the two fees, the executor is the one who goes short
  const squeezed = fees(150_000n, COSTON2);
  assert.equal(squeezed.mintingFeeUba, 100_000n);
  assert.equal(squeezed.executorFeeUba, 50_000n);
  assert.equal(squeezed.netUba, 0n);
});

test("mainnet charges less relative fee and more executor fee", () => {
  const b = fees(100n * XRP, FLARE);
  assert.equal(b.mintingFeeUba, 100_000n); // 10 bips of 100 XRP = 0.1, ties the minimum
  assert.equal(b.executorFeeUba, 200_000n);
  assert.equal(b.netUba, 99_700_000n);
});

test("an invoice nets the merchant what they asked for, and not a drop more than needed", () => {
  const wants = [
    1n, 999n, XRP, 5n * XRP, 25n * XRP, 39n * XRP, 40n * XRP, 41n * XRP,
    100n * XRP, 12_345_678n, 999_999n * XRP, 100_000n * XRP,
  ];
  for (const cfg of [COSTON2, FLARE]) {
    for (const want of wants) {
      const inv = invoice(want, cfg);
      const where = `want ${want} at ${cfg.feeBips} bips`;
      assert.equal(inv.netUba >= want, true, `${where}: nets ${inv.netUba}`);
      assert.equal(inv.tooSmall, false, `${where}: invoiced below the minimum fee`);
      // minimality — one drop less does not cover it
      assert.equal(
        fees(inv.paidUba - 1n, cfg).netUba < want,
        true,
        `${where}: ${inv.paidUba} is one drop too many`,
      );
      // and the breakdown is self-consistent
      assert.equal(inv.paidUba, inv.netUba + inv.mintingFeeUba + inv.executorFeeUba, where);
    }
  }
});

test("invoice minimality holds across a dense sweep, not just chosen points", () => {
  // brute force around the crossover, where the closed forms swap branches
  const cfg = COSTON2;
  for (let want = 39_800_000n; want <= 40_200_000n; want += 7_919n) {
    const inv = invoice(want, cfg);
    assert.equal(inv.netUba >= want, true, `want ${want}`);
    assert.equal(fees(inv.paidUba - 1n, cfg).netUba < want, true, `want ${want} not minimal`);
  }
});

test("a split invoice covers the fees of every piece, not of one payment", () => {
  // Cut at a fixed ceiling, the shape the large-mint cliff forces.
  const cutAt = (cap: bigint) => (gross: bigint) => {
    const out: bigint[] = [];
    let left = gross;
    while (left > 0n) {
      const take = left > cap ? cap : left;
      out.push(take);
      left -= take;
    }
    return out;
  };

  for (const cfg of [COSTON2, FLARE]) {
    for (const [want, cap] of [
      [120_000n * XRP, 99_999_999_999n],
      [1_000n * XRP, 100n * XRP],
      [37n * XRP, 5n * XRP], // many small pieces: the minimum fee dominates each
      [XRP, XRP * 10n], // fits in one piece, must match plain invoice()
    ] as const) {
      const r = invoiceSplit(want, cfg, cutAt(cap));
      const where = `want ${want} cap ${cap} at ${cfg.feeBips} bips`;
      assert.equal(r.netUba >= want, true, `${where}: nets ${r.netUba}`);
      assert.equal(r.paidUba, r.amounts.reduce((a, b) => a + b, 0n), `${where}: sum`);
      assert.equal(r.pieces.every((p) => !p.tooSmall), true, `${where}: a piece is below the minimum fee`);
    }
  }

  // The bug this replaces: grossing up once and then splitting leaves the
  // merchant short by the extra pieces' fees.
  const naive = invoice(120_000n * XRP, COSTON2).paidUba;
  const pieces = cutAt(99_999_999_999n)(naive).map((a) => fees(a, COSTON2));
  const naiveNet = pieces.reduce((a, p) => a + p.netUba, 0n);
  assert.equal(naiveNet < 120_000n * XRP, true, "the naive route should underpay");
  assert.equal(120_000n * XRP - naiveNet, COSTON2.executorFeeUba - 1n, "short by the extra executor fee");
});

test("splitting into many small pieces cannot drive a piece under the minimum fee", () => {
  // 0.25 XRP pieces where the minimum fee is 0.1: legal, but the merchant only
  // keeps 0.05 of each. The invoice has to gross up enormously, and it does.
  const r = invoiceSplit(10n * XRP, COSTON2, (gross) => {
    const cap = XRP / 4n;
    const out: bigint[] = [];
    let left = gross;
    while (left > 0n) {
      const take = left > cap ? cap : left;
      out.push(take);
      left -= take;
    }
    return out;
  });
  assert.equal(r.netUba >= 10n * XRP, true, `nets ${r.netUba}`);
  assert.equal(r.paidUba > 30n * XRP, true, "fees should dominate at this piece size");
});

test("a USD price becomes XRP, rounded so the merchant is never short", () => {
  // 1.105842 USD per XRP, the reading the dashboard showed
  assert.equal(usdToUba(25, 1.105842), 22_607_208n); // 25 / 1.105842 = 22.6072077…, rounded up
  assert.equal(usdToUba(1, 2), 500_000n);
  // granularity coarser than a drop rounds up to a whole AMG
  assert.equal(usdToUba(1, 3, 1000n), 334_000n);
  assert.throws(() => usdToUba(10, 0), /not usable/);
});
