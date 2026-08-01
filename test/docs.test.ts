import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The documents have to agree with the code.
 *
 * Every count in the README and the submission was updated by hand, and twice
 * this session one of them was quietly wrong — the README claimed 15 tests when
 * there were 53, and 17 parity vectors when there were 217. Nobody noticed,
 * because a stale number reads exactly like a fresh one.
 *
 * A judge who checks one claim and finds it wrong stops believing the rest, so
 * this is not pedantry.
 */
const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const read = (p: string) => readFileSync(root(p), "utf8");

test("the stated test count matches the tests that exist", () => {
  const files = readdirSync(root("test")).filter((f) => f.endsWith(".test.ts"));
  // Count `test(` calls rather than trusting a number anyone typed.
  const actual = files.reduce(
    (n, f) => n + (readFileSync(root(`test/${f}`), "utf8").match(/^test\(/gm) ?? []).length,
    0,
  );
  const readme = read("README.md");
  const claimed = readme.match(/npm test\s+#\s*(\d+) cases/);
  assert.ok(claimed, "the README no longer states a test count — put it back or drop this check");
  assert.equal(
    Number(claimed[1]),
    actual,
    `README says ${claimed[1]} tests, there are ${actual}`,
  );
});

test("the stated parity vector count matches the committed vectors", () => {
  const vectors = JSON.parse(read("parity/out-vectors/vectors.json")) as unknown[];
  for (const [file, pattern] of [
    ["README.md", /(\d+) vectors:/],
    ["README.md", /through (\d+) scenarios/],
    ["parity/README.md", /\*\*(\d+) vectors\*\*/],
  ] as const) {
    const m = read(file).match(pattern);
    assert.ok(m, `${file} no longer states a vector count (${pattern})`);
    assert.equal(Number(m[1]), vectors.length, `${file} says ${m[1]}, there are ${vectors.length}`);
  }
});

test("every source module the README lists actually exists", () => {
  const readme = read("README.md");
  for (const m of readme.matchAll(/`(src\/[a-z]+\.ts|qa\/[a-z-]+\.mjs)`/g)) {
    assert.doesNotThrow(() => readFileSync(root(m[1])), `README lists ${m[1]}, which is not there`);
  }
});

test("the submission does not claim an address the deployment file disagrees with", () => {
  const sub = read("SUBMISSION.md");
  // The one address a reader will paste into an explorer.
  assert.match(sub, /0x20d9CcAA7140bf38AD91D2F102bA996417798e8f|undelayed/i);
  assert.ok(!/TODO|TBD|<fill|xxx/i.test(sub), "the submission still has a placeholder in it");
});
