import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { record, type Limiter } from "../src/limiter.js";

/**
 * Differential test against the real thing.
 *
 * ../parity runs the verified Coston2 `MintingRateLimiter` under Foundry and
 * writes down what it did. This replays the same steps through our TypeScript
 * and demands identical output — delayed flag, allowedAt, and both pieces of
 * post-state. If Flare changes the limiter, this is what fails, rather than the
 * product quietly mispredicting.
 *
 * Regenerate with: npm run parity
 */
const VECTORS = fileURLToPath(new URL("../parity/out-vectors/vectors.json", import.meta.url));

type Vector = {
  windowSize: string | number;
  maxPerWindow: string | number;
  now: string | number;
  amount: string | number;
  windowStartBefore: string | number;
  mintedBefore: string | number;
  delayed: boolean;
  allowedAt: string | number;
  windowStartAfter: string | number;
  mintedAfter: string | number;
};

test("the TypeScript replay matches the Solidity limiter exactly", () => {
  assert.ok(
    existsSync(VECTORS),
    `no vectors at ${VECTORS} — run "npm run parity" (needs forge)`,
  );
  const vectors = JSON.parse(readFileSync(VECTORS, "utf8")) as Vector[];
  assert.ok(vectors.length >= 10, `only ${vectors.length} vectors`);

  for (const [i, v] of vectors.entries()) {
    const before: Limiter = {
      windowSizeSeconds: BigInt(v.windowSize),
      maxPerWindow: BigInt(v.maxPerWindow),
      windowStart: BigInt(v.windowStartBefore),
      minted: BigInt(v.mintedBefore),
    };
    const got = record(before, BigInt(v.amount), BigInt(v.now));
    const where = `vector ${i} (amount ${v.amount} at ${v.now})`;

    assert.equal(got.delayed, v.delayed, `${where}: delayed`);
    assert.equal(got.allowedAt, BigInt(v.allowedAt), `${where}: allowedAt`);
    assert.equal(got.next.windowStart, BigInt(v.windowStartAfter), `${where}: windowStart`);
    assert.equal(got.next.minted, BigInt(v.mintedAfter), `${where}: minted`);
  }
});
