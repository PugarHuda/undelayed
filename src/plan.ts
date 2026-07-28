/**
 * Delay-aware splitting.
 *
 * A merchant with a large amount has a choice the raw API never shows them:
 * send one payment, or several. The two are not equivalent, because the large-
 * mint rule is a cliff, not a slope — one XRP over the threshold buys a flat
 * delay, while the same total split below it goes through the ordinary limiter
 * and part of the money can land immediately.
 *
 * This does not pretend to be an optimiser. It simulates both and reports what
 * each actually costs, including the case where splitting is worse.
 */
import { advance, predict, record, undelayedCapacity, type Limits } from "./limiter.js";

export type Chunk = { amountAmg: bigint; allowedAt: bigint; delayed: boolean };

export type Plan = {
  chunks: Chunk[];
  /** When the first chunk may execute — what the customer sees as "it worked". */
  firstAt: bigint;
  /** When the last chunk may execute — when the merchant holds the full amount. */
  lastAt: bigint;
};

/** Walk the limiters forward as each chunk is recorded, exactly as the facet does. */
function simulate(limits: Limits, amounts: bigint[], now: bigint): Plan {
  let state = { ...limits, hourly: { ...limits.hourly }, daily: { ...limits.daily } };
  const chunks: Chunk[] = [];

  for (const amountAmg of amounts) {
    if (amountAmg >= state.largeThresholdAmg) {
      // large mintings skip both limiters, so no limiter state advances here
      chunks.push({
        amountAmg,
        allowedAt: now + state.largeDelaySeconds,
        delayed: true,
      });
      continue;
    }
    const h = record(state.hourly, amountAmg, now);
    const d = record(state.daily, amountAmg, now);
    state = { ...state, hourly: h.next, daily: d.next };
    const delayed = h.delayed || d.delayed;
    chunks.push({
      amountAmg,
      allowedAt: delayed ? (h.allowedAt > d.allowedAt ? h.allowedAt : d.allowedAt) : now,
      delayed,
    });
  }

  const times = chunks.map((c) => c.allowedAt);
  return {
    chunks,
    firstAt: times.reduce((a, b) => (b < a ? b : a), times[0] ?? now),
    lastAt: times.reduce((a, b) => (b > a ? b : a), times[0] ?? now),
  };
}

/**
 * Split greedily: take everything that executes immediately, then fill in
 * chunks just under the large-mint threshold.
 *
 * No chunk may ever reach the threshold — that is the whole point of splitting,
 * so the piece count is not something the caller gets to cap. Each chunk costs
 * a separate XRPL payment, FDC proof and executor fee, so read `chunks.length`
 * before deciding this is worth it.
 */
export function splitAmounts(limits: Limits, amountAmg: bigint, now: bigint): bigint[] {
  const cap = limits.largeThresholdAmg - 1n;
  if (cap <= 0n) return [amountAmg]; // no cliff to stay under
  const immediate = undelayedCapacity(limits, now);
  const out: bigint[] = [];
  let left = amountAmg;

  if (immediate > 0n && immediate < left) {
    out.push(immediate);
    left -= immediate;
  }
  while (left > 0n) {
    const take = left > cap ? cap : left;
    out.push(take);
    left -= take;
  }
  return out.length ? out : [amountAmg];
}

export type Comparison = {
  single: Plan;
  split: Plan;
  /** True when splitting gets the whole amount settled no later, and starts sooner. */
  splitWins: boolean;
  /** Seconds saved on the first arrival by splitting; negative means splitting is worse. */
  firstArrivalSaved: bigint;
};

export function comparePlans(limits: Limits, amountAmg: bigint, now: bigint): Comparison {
  const single = simulate(limits, [amountAmg], now);
  const split = simulate(limits, splitAmounts(limits, amountAmg, now), now);
  return {
    single,
    split,
    splitWins: split.lastAt <= single.lastAt && split.firstAt < single.firstAt,
    firstArrivalSaved: single.firstAt - split.firstAt,
  };
}

/** Re-exported so callers can reason about one payment without importing two modules. */
export { predict, advance };
