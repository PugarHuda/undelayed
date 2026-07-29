import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTag, parseAmount } from "../src/args.js";

test("a destination tag is a uint32, and nothing else is", () => {
  assert.equal(parseTag("205"), 205);
  assert.equal(parseTag("0"), 0);
  assert.equal(parseTag("4294967295"), 4_294_967_295);

  for (const bad of [undefined, "", "  ", "abc", "-5", "1.5", "4294967296", "1e40", "0x10", "NaN"]) {
    assert.throws(() => parseTag(bad), /not a destination tag/, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a missing flag value is reported as missing, not as a bad number", () => {
  // `npm run pay -- 205 --usd --quote` used to take "--quote" as the price and
  // die inside BigInt() with "The number NaN cannot be converted".
  assert.throws(() => parseAmount("--quote", "--usd"), /--usd needs a value/);
  assert.throws(() => parseAmount(undefined, "--net"), /--net needs a value/);
  assert.throws(() => parseAmount("", "--net"), /--net needs a value/);
});

test("an amount has to be a positive number", () => {
  assert.equal(parseAmount("25", "--usd"), 25);
  assert.equal(parseAmount("0.000001", "--usd"), 0.000001);

  for (const bad of ["abc", "0", "-1", "1e999", "NaN", "1,5"]) {
    assert.throws(() => parseAmount(bad, "--usd"), /not a positive amount/, `accepted ${JSON.stringify(bad)}`);
  }
});
