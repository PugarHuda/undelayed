import { test } from "node:test";
import assert from "node:assert/strict";
import { attemptPayment, ALREADY_CONFIRMED, type Deps, type Entry } from "../src/attempt.js";
import type { FeeConfig } from "../src/fees.js";

const XRP = 1_000_000n;
const COSTON2: FeeConfig = { feeBips: 25n, minimumFeeUba: XRP / 10n, executorFeeUba: XRP / 10n };

/** Records what the outside world was asked to do, so the sequence is checkable. */
function spy(over: Partial<Deps> = {}) {
  const calls: string[] = [];
  const saved: Entry[] = [];
  const deps: Deps = {
    requestProof: async () => {
      calls.push("requestProof");
      return { request: "0xreq", votingRound: 1408178 };
    },
    fetchProof: async (round, request) => {
      calls.push(`fetchProof(${round},${request})`);
      return { proof: true };
    },
    simulate: async () => {
      calls.push("simulate");
    },
    execute: async () => {
      calls.push("execute");
      return "0xhash";
    },
    save: (e) => {
      calls.push("save");
      saved.push(e);
    },
    ...over,
  };
  return { deps, calls, saved };
}

test("a clean attempt buys one proof, simulates, and executes in that order", async () => {
  const { deps, calls } = spy();
  const r = await attemptPayment({}, 7n * XRP, COSTON2, deps);

  assert.equal(r.outcome, "won");
  assert.equal(r.outcome === "won" && r.hash, "0xhash");
  assert.deepEqual(calls, [
    "requestProof",
    "save", // before anything else can fail
    "fetchProof(1408178,0xreq)",
    "simulate",
    "execute",
    "save",
  ]);
});

test("a proof is paid for once, however many times we come back", async () => {
  // The delayed case: an hour later, same payment, request already recorded.
  const { deps, calls } = spy();
  const existing: Entry = { request: "0xalready", votingRound: 1407000 };
  const r = await attemptPayment(existing, 7n * XRP, COSTON2, deps);

  assert.equal(r.outcome, "won");
  assert.equal(calls.includes("requestProof"), false, "bought a second attestation");
  assert.equal(calls[0], "fetchProof(1407000,0xalready)", "used the wrong request");
});

test("the request is recorded before the proof is fetched", async () => {
  // If fetching throws and the request was not saved, the next tick buys
  // another one — the exact way to pay twice for the same payment.
  const { deps, calls, saved } = spy({});
  // Overriding the spy wholesale would drop its bookkeeping, so wrap it.
  const realFetch = deps.fetchProof;
  deps.fetchProof = async (r, q) => {
    await realFetch(r, q);
    throw new Error("DA layer is down");
  };
  await assert.rejects(() => attemptPayment({}, 7n * XRP, COSTON2, deps), /DA layer/);
  assert.deepEqual(calls, ["requestProof", "save", "fetchProof(1408178,0xreq)"]);
  assert.equal(saved[0].request, "0xreq");
  assert.equal(saved[0].done, undefined, "a failed fetch must not close the payment");
});

test("a lost race is retired, not retried", async () => {
  const { deps, calls, saved } = spy({
    simulate: async () => {
      calls.push("simulate");
      throw new Error(`execution reverted, data: ${ALREADY_CONFIRMED}`);
    },
  });
  const r = await attemptPayment({ request: "0xr", votingRound: 1n as unknown as number }, 7n * XRP, COSTON2, deps);

  assert.equal(r.outcome, "lost");
  assert.equal(calls.includes("execute"), false, "paid gas for a call that cannot succeed");
  assert.equal(saved.at(-1)?.done, true, "a lost race must be closed");
  assert.equal(saved.at(-1)?.outcome, "lost");
});

test("any other revert is deferred, and keeps the proof it paid for", async () => {
  const { deps, calls, saved } = spy({
    simulate: async () => {
      calls.push("simulate");
      throw new Error("DirectMintingStillDelayed(1785300000)");
    },
  });
  const r = await attemptPayment({ request: "0xr", votingRound: 7 }, 7n * XRP, COSTON2, deps);

  assert.equal(r.outcome, "deferred");
  assert.equal(r.entry.done, undefined, "a delay is not an ending");
  assert.equal(r.entry.request, "0xr", "the proof we already bought must survive");
  assert.equal(calls.includes("execute"), false);
  assert.equal(saved.length, 0, "nothing to record for an attempt that will be repeated");
});

test("the fee recorded is the one actually paid, not the setting", async () => {
  // 0.15 XRP: the system fee takes its 0.1 minimum and the executor gets 0.05.
  const { deps } = spy();
  const r = await attemptPayment({}, 150_000n, COSTON2, deps);
  assert.equal(r.outcome === "won" && r.feeUba, 50_000n);
  assert.equal(r.entry.feeUba, "50000");
});

test("a deferred attempt then succeeds without buying anything new", async () => {
  let delayed = true;
  const { deps, calls } = spy({
    simulate: async () => {
      calls.push("simulate");
      if (delayed) throw new Error("DirectMintingStillDelayed(1785300000)");
    },
  });

  const first = await attemptPayment({}, 7n * XRP, COSTON2, deps);
  assert.equal(first.outcome, "deferred");

  delayed = false;
  const second = await attemptPayment(first.entry, 7n * XRP, COSTON2, deps);
  assert.equal(second.outcome, "won");
  assert.equal(calls.filter((c) => c === "requestProof").length, 1, "bought a second proof on the retry");
});
