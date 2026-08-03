/**
 * What a proved payment means, as a pure function.
 *
 * `prove.ts` is a script: it fetches, decodes and prints, all at the top level,
 * so nothing in it could be tested. The fetching is `fdc.ts` and already has
 * tests. What did not was the judgement — who gets the FXRP, how much of it
 * survives the fees, and when. That is the part a merchant would act on.
 */
import { ask, type Snapshot } from "./chain.js";
import { fees } from "./fees.js";
import { estimate } from "./estimate.js";
import type { XRPPaymentProof } from "./fdc.js";

export type Verdict = {
  /** The tagged recipient, or why there is not one. */
  recipient: string;
  receivedUba: bigint;
  netUba: bigint;
  delayed: boolean;
  reason: string;
  /** Seconds until execution is allowed. Zero when it is allowed now. */
  waitSeconds: bigint;
  /** What a merchant would tell the customer. */
  text: string;
  /** True when the payment mints nothing at all. */
  rejected: boolean;
};

const NO_TAG = "(no registered tag — falls back to the memo payment reference)";

/**
 * `registered` is what the tag manager returned, or null when the payment
 * carries no destination tag. Passed in rather than read here, so this stays
 * free of the chain.
 */
export function describe(
  proof: XRPPaymentProof,
  snap: Snapshot,
  registered: string | null,
): Verdict {
  const body = proof.data.responseBody;
  const receivedUba = BigInt(body.receivedAmount);
  const split = fees(receivedUba, snap.fees);
  const a = ask(snap, receivedUba);
  const e = estimate(snap, receivedUba);

  const ZERO = "0x0000000000000000000000000000000000000000";
  const recipient =
    body.hasDestinationTag && registered && registered !== ZERO ? registered : NO_TAG;

  return {
    recipient,
    receivedUba,
    netUba: split.netUba,
    delayed: a.delayed,
    reason: a.reason,
    waitSeconds: a.waitSeconds,
    text: e.text,
    rejected: split.tooSmall,
  };
}
