import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type Facts } from "../src/decide.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const ME = "0x100158159dD923E6009a1eD56fB2e8b2347aF42f";
const OTHER = "0xDcDD7547EdA881b675B58c11922aF4A726cCb01B";
const MERCHANT = "0x1111111111111111111111111111111111111111";

const base: Facts = {
  recipient: MERCHANT,
  allowedExecutor: ZERO,
  me: ME,
  now: 1_800_000_000n,
  paidAt: 1_800_000_000n - 100n,
  exclusiveFor: 7200n,
  delayState: 0,
  allowedAt: 0n,
  finished: false,
};
const f = (over: Partial<Facts>): Facts => ({ ...base, ...over });

test("an open, undelayed payment on a registered tag is executed", () => {
  assert.deepEqual(decide(base), { action: "execute" });
});

test("an unregistered tag is not ours to serve", () => {
  assert.equal(decide(f({ recipient: ZERO })).action, "skip");
});

test("a finished payment is never touched again", () => {
  // whatever else is true — this is what stops a lost race looping forever
  assert.equal(decide(f({ finished: true, delayState: 1, allowedAt: 0n })).action, "skip");
});

test("someone else's exclusive window is waited out, not skipped", () => {
  const d = decide(f({ allowedExecutor: OTHER, paidAt: base.now - 100n }));
  assert.equal(d.action, "wait");
  assert.equal(d.action === "wait" && d.until, base.now - 100n + 7200n);
});

test("once that window closes the rail is permissionless again", () => {
  // 7200s + 1 after the payment: the other executor never showed up
  const d = decide(f({ allowedExecutor: OTHER, paidAt: base.now - 7201n }));
  assert.deepEqual(d, { action: "execute" });
});

test("the boundary is exclusive on the last second and open on the next", () => {
  const at = (age: bigint) => decide(f({ allowedExecutor: OTHER, paidAt: base.now - age })).action;
  assert.equal(at(7199n), "wait");
  assert.equal(at(7200n), "execute"); // now == opensAt, and the check is `now < opensAt`
});

test("our own tag is never treated as someone else's", () => {
  // same address, different casing — the comparison must not care
  assert.deepEqual(decide(f({ allowedExecutor: ME.toLowerCase(), paidAt: base.now })), { action: "execute" });
});

test("a missing ledger time waits rather than guessing the window is open", () => {
  const d = decide(f({ allowedExecutor: OTHER, paidAt: null }));
  assert.equal(d.action, "wait");
  // and it does not invent a deadline it cannot know
  assert.equal(d.action === "wait" && d.until, base.now);
});

test("a payment we already own needs no ledger time", () => {
  assert.deepEqual(decide(f({ allowedExecutor: ME, paidAt: null })), { action: "execute" });
});

test("a delayed minting is waited out, and executed the moment it is allowed", () => {
  const allowedAt = base.now + 600n;
  const d = decide(f({ delayState: 1, allowedAt }));
  assert.equal(d.action, "wait");
  assert.equal(d.action === "wait" && d.until, allowedAt);

  // at allowedAt exactly, the contract permits it
  assert.deepEqual(decide(f({ delayState: 1, allowedAt: base.now })), { action: "execute" });
});

test("a released minting executes even though it was once delayed", () => {
  assert.deepEqual(decide(f({ delayState: 2, allowedAt: base.now + 10_000n })), { action: "execute" });
});

test("exclusivity is checked before the delay, so we never wait on a payment that is not ours", () => {
  // both apply: another executor holds it AND it is rate-limited. The answer
  // has to be the exclusivity window, because acting at allowedAt would still
  // revert.
  const d = decide(
    f({ allowedExecutor: OTHER, paidAt: base.now - 100n, delayState: 1, allowedAt: base.now + 10n }),
  );
  assert.equal(d.action, "wait");
  assert.equal(d.action === "wait" && d.until, base.now - 100n + 7200n);
});
