/**
 * "Your FXRP arrives in about forty minutes."
 *
 * A checkout shows a spinner because the integrator has nothing better to say.
 * Everything needed for a real answer is already here — the limiter replay knows
 * when execution is allowed, and the FDC round trip has a measured floor — so
 * the spinner is a choice, not a limitation.
 *
 * The estimate is deliberately conservative and deliberately coarse. A merchant
 * who promises four minutes and delivers seven has lied to their customer; one
 * who says "a few minutes" has not. Rounding up and speaking in bands is the
 * honest shape for a number with this much variance in it.
 */
import { predict, ubaToAmg, type Limits } from "./limiter.js";
import { fees, type FeeConfig } from "./fees.js";

/**
 * What the rail costs even when nothing is delayed, measured rather than
 * guessed: an FDC voting round is 90s and the proof only appears once the round
 * is signed, plus the executor's own polling interval and the settlement block.
 * Our own round trip on Coston2 took a little over two minutes.
 */
export const FLOOR_SECONDS = 150n;

export type Estimate = {
  /** Seconds from now, including the FDC floor. */
  seconds: bigint;
  /** What a customer should be told. */
  text: string;
  /** Why it is not immediate, for a merchant's own logs. */
  reason: "none" | "large" | "hourly" | "daily" | "hourly+daily";
  /** True when the payment mints nothing at all — not a delay, a rejection. */
  rejected: boolean;
  /** What the recipient is actually credited. */
  netUba: bigint;
};

/** Coarse on purpose: a band nobody can be disappointed by. */
function phrase(seconds: bigint): string {
  if (seconds <= 60n) return "in under a minute";
  if (seconds <= 300n) return "in a few minutes";
  if (seconds <= 900n) return "within about fifteen minutes";
  if (seconds <= 3600n) return "within the hour";
  // Above an hour, always round UP. An hour and two minutes described as "about
  // an hour" is a promise that has already expired by the time it is read.
  const hours = (seconds + 3599n) / 3600n;
  return hours === 1n ? "within the hour" : `in about ${hours} hours`;
}

export type EstimateInput = Limits & {
  granularityUba: bigint;
  fees: FeeConfig;
  now: bigint;
};

/**
 * When will the recipient hold the FXRP, if the customer pays this now?
 *
 * `now` is chain time from a pinned snapshot, not the local clock — the limiter
 * is evaluated against block timestamps and a laptop that is thirty seconds
 * fast would quietly shorten every estimate.
 */
export function estimate(snap: EstimateInput, paidUba: bigint): Estimate {
  const split = fees(paidUba, snap.fees);
  if (split.tooSmall) {
    return {
      seconds: 0n,
      text: "this payment is below the minimum fee and would mint nothing",
      reason: "none",
      rejected: true,
      netUba: 0n,
    };
  }

  const p = predict(snap, ubaToAmg(paidUba, snap.granularityUba), snap.now);
  const delay = p.allowedAt > snap.now ? p.allowedAt - snap.now : 0n;
  const seconds = delay + FLOOR_SECONDS;

  return {
    seconds,
    text: `arrives ${phrase(seconds)}`,
    reason: p.reason,
    rejected: false,
    netUba: split.netUba,
  };
}

/**
 * The line a checkout can print under the pay button. Includes the amount,
 * because "arrives in about an hour" is only half of what the customer is
 * agreeing to.
 */
export function checkoutLine(snap: EstimateInput, paidUba: bigint): string {
  const e = estimate(snap, paidUba);
  if (e.rejected) return e.text;
  const xrp = (u: bigint) => (Number(u) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });
  const why =
    e.reason === "none"
      ? ""
      : e.reason === "large"
        ? " (large mintings are delayed by protocol)"
        : ` (the ${e.reason} mint limit is binding)`;
  return `${xrp(e.netUba)} FXRP ${e.text}${why}`;
}
