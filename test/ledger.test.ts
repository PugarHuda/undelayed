import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ledger, importLegacyState, publicRecord, CLAIM_TTL_MS } from "../src/ledger.js";

const TX = "0x6465efff817afd17cb68a3c7b59d9942678e1650c308e4d058755be7050ac07b";
const TX2 = "0xdcd6e28b7218b454391505b0321e351cab839be6910025fcbe550e1680600a47";

const fresh = () => mkdtempSync(path.join(tmpdir(), "ledger-"));

test("two executors cannot both claim the same payment", () => {
  const dir = fresh();
  const a = new Ledger(dir, "worker-a");
  const b = new Ledger(dir, "worker-b");

  const first = a.claim(TX);
  const second = b.claim(TX);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false, "both processes claimed it — both would buy a proof");
  assert.equal(second.ok === false && second.heldBy, "worker-a");
  rmSync(dir, { recursive: true, force: true });
});

test("a claim is re-entrant for the process that holds it", () => {
  const dir = fresh();
  const a = new Ledger(dir, "worker-a");
  assert.equal(a.claim(TX).ok, true);
  assert.equal(a.claim(TX).ok, true, "a process must be able to resume its own payment");
  rmSync(dir, { recursive: true, force: true });
});

test("different payments do not block each other", () => {
  const dir = fresh();
  const a = new Ledger(dir, "worker-a");
  const b = new Ledger(dir, "worker-b");
  assert.equal(a.claim(TX).ok, true);
  assert.equal(b.claim(TX2).ok, true, "two executors must be able to work in parallel");
  rmSync(dir, { recursive: true, force: true });
});

test("a crashed worker's claim is taken over after the TTL, keeping its proof", () => {
  const dir = fresh();
  const dead = new Ledger(dir, "crashed");
  dead.claim(TX);
  dead.save(TX, { request: "0xpaidfor", votingRound: 1408178 });

  // Rewind the claim past the TTL, as a stale lock would be.
  const f = path.join(dir, `${TX}.json`);
  const held = JSON.parse(readFileSync(f, "utf8"));
  writeFileSync(f, JSON.stringify({ ...held, claimedAt: Date.now() - CLAIM_TTL_MS - 1000 }));

  const rescuer = new Ledger(dir, "worker-b");
  const taken = rescuer.claim(TX);
  assert.equal(taken.ok, true, "a stale claim must not strand a payment forever");
  assert.equal(
    taken.ok === true && taken.entry.request,
    "0xpaidfor",
    "the takeover lost the request — the proof would be bought a second time",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("a fresh claim is not stolen", () => {
  const dir = fresh();
  new Ledger(dir, "worker-a").claim(TX);
  assert.equal(new Ledger(dir, "worker-b").claim(TX).ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test("a finished payment is never handed out again", () => {
  const dir = fresh();
  const a = new Ledger(dir, "worker-a");
  a.claim(TX);
  a.save(TX, { done: true, outcome: "won", feeUba: "100000" });
  const b = new Ledger(dir, "worker-b").claim(TX);
  assert.equal(b.ok, false);
  assert.equal(b.ok === false && b.heldBy, "finished");
  rmSync(dir, { recursive: true, force: true });
});

test("books add up across processes", () => {
  const dir = fresh();
  const a = new Ledger(dir, "worker-a");
  const b = new Ledger(dir, "worker-b");
  a.claim(TX);
  a.save(TX, { done: true, outcome: "won", feeUba: "100000" });
  b.claim(TX2);
  b.save(TX2, { done: true, outcome: "lost" });

  const t = new Ledger(dir, "reporter").totals();
  assert.equal(t.won, 1);
  assert.equal(t.lost, 1);
  assert.equal(t.earnedUba, 100_000n);
  assert.equal(t.workers, 2, "two executors should show as two");
  rmSync(dir, { recursive: true, force: true });
});

test("the old single-file state is imported, not re-bought", () => {
  const dir = fresh();
  const legacy = path.join(dir, "bot-state.coston2.json");
  writeFileSync(
    legacy,
    JSON.stringify({
      [TX]: { request: "0xalready", votingRound: 1408178, done: true, outcome: "won", feeUba: "100000" },
      [TX2]: { request: "0xpending", votingRound: 1408179 },
      "not-a-tx-id": { request: "0xjunk" },
    }),
  );
  const l = new Ledger(path.join(dir, "ledger"), "importer");
  assert.equal(importLegacyState(l, legacy), 2, "junk keys must be skipped");
  assert.equal(l.read(TX2)?.request, "0xpending", "a paid-for proof must survive the upgrade");
  assert.equal(importLegacyState(l, legacy), 0, "importing twice must not duplicate");
  rmSync(dir, { recursive: true, force: true });
});

test("a path that is not a transaction id is refused", () => {
  const dir = fresh();
  const l = new Ledger(dir, "worker-a");
  for (const bad of ["../escape", "0xshort", "", "0x" + "z".repeat(64)]) {
    assert.throws(() => l.claim(bad), /not a transaction id/, `accepted ${JSON.stringify(bad)}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("the published record counts losses, and refuses a rate computed from nothing", () => {
  const dir = fresh();
  const a = new Ledger(dir, "worker-a");
  a.claim(TX);
  a.save(TX, { done: true, outcome: "won", feeUba: "100000", tag: "205" });
  a.claim(TX2);
  a.save(TX2, { done: true, outcome: "lost", tag: "206" });

  const r = publicRecord(a, "0xexec", "coston2", "2026-08-02T00:00:00Z");
  assert.equal(r.finalised, 1);
  assert.equal(r.lostRaces, 1, "a record that hides losses is an advert");
  assert.equal(r.winRatePct, 50);
  assert.equal(r.earnedXrp, 0.1);
  assert.deepEqual(r.tags, ["205", "206"]);

  const empty = publicRecord(new Ledger(fresh(), "new"), "0xnew", "coston2", "now");
  assert.equal(empty.winRatePct, null, "a rate from no data is a claim, not evidence");
  rmSync(dir, { recursive: true, force: true });
});
