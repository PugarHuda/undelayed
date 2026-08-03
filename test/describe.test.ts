import { test } from "node:test";
import assert from "node:assert/strict";
import { describe as verdict } from "../src/describe.js";
import type { Snapshot } from "../src/chain.js";

const XRP = 1_000_000n;
const NOW = 1_800_000_000n;
const TAGGED = "0x1111111111111111111111111111111111111111";

const snap = (): Snapshot => ({
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
});

const proof = (receivedUba: bigint, hasTag = true) =>
  ({
    merkleProof: [],
    data: { responseBody: { receivedAmount: receivedUba, hasDestinationTag: hasTag, destinationTag: 205n } },
  }) as any;

test("a tagged payment names its recipient and what survives the fees", () => {
  const v = verdict(proof(7n * XRP), snap(), TAGGED);
  assert.equal(v.recipient, TAGGED);
  assert.equal(v.receivedUba, 7n * XRP);
  assert.equal(v.netUba, 6_800_000n, "7 XRP in, 0.1 system + 0.1 executor out");
  assert.equal(v.delayed, false);
  assert.equal(v.rejected, false);
});

test("an unregistered tag is reported as such, not as an address", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";
  assert.match(verdict(proof(7n * XRP), snap(), ZERO).recipient, /no registered tag/);
  assert.match(verdict(proof(7n * XRP), snap(), null).recipient, /no registered tag/);
  // A payment with no tag at all cannot use a registered recipient either.
  assert.match(verdict(proof(7n * XRP, false), snap(), TAGGED).recipient, /no registered tag/);
});

test("a large payment reports the delay and says so in words", () => {
  const v = verdict(proof(150_000n * XRP), snap(), TAGGED);
  assert.equal(v.delayed, true);
  assert.equal(v.reason, "large");
  assert.equal(v.waitSeconds, 3600n);
  assert.match(v.text, /hours/);
});

test("a payment below the minimum fee is a rejection, and nothing is promised", () => {
  const v = verdict(proof(50_000n), snap(), TAGGED);
  assert.equal(v.rejected, true);
  assert.equal(v.netUba, 0n);
  assert.match(v.text, /mint nothing/);
});
