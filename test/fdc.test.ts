import { test } from "node:test";
import assert from "node:assert/strict";
import { padHex, stringToHex } from "viem";
import { checkProof, type XRPPaymentProof } from "../src/fdc.js";

const name32 = (s: string) => padHex(stringToHex(s), { size: 32, dir: "right" });
const TX = "0x6465efff817afd17cb68a3c7b59d9942678e1650c308e4d058755be7050ac07b" as const;

/** Shaped like what the DA layer returns for a real Coston2 payment. */
const proof = (over: Partial<XRPPaymentProof["data"]> = {}, body: Record<string, unknown> = {}): XRPPaymentProof => ({
  merkleProof: ["0xaa"],
  data: {
    attestationType: name32("XRPPayment"),
    sourceId: name32("testXRP"),
    votingRound: 1408178n,
    lowestUsedTimestamp: 0n,
    requestBody: { transactionId: TX, proofOwner: "0x0000000000000000000000000000000000000000" },
    responseBody: {
      blockNumber: 0n,
      blockTimestamp: 0n,
      sourceAddress: "rTest",
      sourceAddressHash: "0x00",
      receivingAddressHash: "0x00",
      intendedReceivingAddressHash: "0x00",
      spentAmount: 7_000_000n,
      intendedSpentAmount: 7_000_000n,
      receivedAmount: 7_000_000n,
      intendedReceivedAmount: 7_000_000n,
      hasMemoData: false,
      firstMemoData: "0x",
      hasDestinationTag: true,
      destinationTag: 205n,
      status: 0,
      ...body,
    },
    ...over,
  } as XRPPaymentProof["data"],
});

const expected = { transactionId: TX, sourceId: "testXRP", votingRound: 1408178 };

test("the proof we asked for passes", () => {
  assert.deepEqual(checkProof(proof(), expected), []);
});

test("a proof for a different payment is caught", () => {
  const other = "0xdcd6e28b7218b454391505b0321e351cab839be6910025fcbe550e1680600a47" as const;
  const p = proof({ requestBody: { transactionId: other, proofOwner: "0x0000000000000000000000000000000000000000" } });
  const problems = checkProof(p, expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is for 0xdcd6/);
});

test("transaction ids compare case-insensitively", () => {
  const p = proof({
    requestBody: { transactionId: TX.toUpperCase().replace("0X", "0x") as `0x${string}`, proofOwner: "0x0000000000000000000000000000000000000000" },
  });
  assert.deepEqual(checkProof(p, expected), []);
});

test("a proof from another round is caught", () => {
  // the round is what keys the DA lookup; a stale one would prove a real
  // payment against the wrong Merkle root
  const problems = checkProof(proof({ votingRound: 1408177n }), expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /round 1408177/);
});

test("the wrong attestation type or source is caught", () => {
  assert.match(checkProof(proof({ attestationType: name32("Payment") }), expected)[0], /attestation type/);
  assert.match(checkProof(proof({ sourceId: name32("XRP") }), expected)[0], /source is/);
});

test("a payment that failed on XRPL is not proof of anything mintable", () => {
  const problems = checkProof(proof({}, { status: 1 }), expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /did not succeed/);
});

test("an empty Merkle proof is allowed — a single-attestation round has no siblings", () => {
  assert.deepEqual(checkProof({ ...proof(), merkleProof: [] }, expected), []);
});

test("several problems are all reported, not just the first", () => {
  const p = proof({ votingRound: 9n, sourceId: name32("XRP") }, { status: 2 });
  assert.equal(checkProof(p, expected).length, 3);
});
