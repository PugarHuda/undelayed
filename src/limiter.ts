/**
 * A byte-for-byte replay of the FAssets direct-minting rate limiter.
 *
 * Mirrors, on-chain sources read from the verified Coston2 AssetManager:
 *   contracts/assetManager/library/data/MintingRateLimiter.sol
 *   contracts/assetManager/facets/DirectMintingFacet.sol :: _checkRateLimits
 *
 * Everything here is in AMG (asset minting granularity), the unit the limiter
 * actually stores. Callers convert with amgToUba/ubaToAmg.
 */

export type Limiter = {
  windowSizeSeconds: bigint;
  maxPerWindow: bigint;
  windowStart: bigint;
  minted: bigint;
};

export type Limits = {
  hourly: Limiter;
  daily: Limiter;
  largeThresholdAmg: bigint;
  largeDelaySeconds: bigint;
};

export type Prediction = {
  delayed: boolean;
  /** Timestamp the minting may execute at. Equal to `now` when not delayed. */
  allowedAt: bigint;
  /** Which rule bound the answer. */
  reason: "none" | "large" | "hourly" | "daily" | "hourly+daily";
  /** Large mintings skip both limiters — they never consume window quota. */
  consumesWindowQuota: boolean;
};

/**
 * MintingRateLimiter._processElapsedWindows.
 *
 * Note this is NOT a tumbling window: overspend carries into later windows
 * (subOrZero of one whole limit per elapsed window), which is why a mint of
 * 5x the limit is delayed ~5 windows rather than until the next boundary.
 */
export function advance(l: Limiter, now: bigint): Limiter {
  if (now <= l.windowStart) return l;
  const elapsed = (now - l.windowStart) / l.windowSizeSeconds; // floor
  if (elapsed === 0n) return l;
  const debt = elapsed * l.maxPerWindow;
  return {
    ...l,
    minted: l.minted > debt ? l.minted - debt : 0n,
    windowStart: l.windowStart + elapsed * l.windowSizeSeconds,
  };
}

/** MintingRateLimiter.recordMinting. The amount is recorded even when delayed. */
export function record(
  l: Limiter,
  amountAmg: bigint,
  now: bigint,
): { delayed: boolean; allowedAt: bigint; next: Limiter } {
  const a = advance(l, now);
  const next = { ...a, minted: a.minted + amountAmg };
  // strict `<` on-chain: landing exactly on the limit is already a delay
  if (next.minted < a.maxPerWindow) {
    return { delayed: false, allowedAt: now, next };
  }
  return {
    delayed: true,
    allowedAt:
      a.windowStart + (a.windowSizeSeconds * next.minted) / a.maxPerWindow,
    next,
  };
}

/** DirectMintingFacet._checkRateLimits, for a minting not yet delayed. */
export function predict(
  limits: Limits,
  amountAmg: bigint,
  now: bigint,
): Prediction {
  if (amountAmg >= limits.largeThresholdAmg) {
    // large mintings have their own limiter and never touch hourly/daily
    return {
      delayed: true,
      allowedAt: now + limits.largeDelaySeconds,
      reason: "large",
      consumesWindowQuota: false,
    };
  }
  const h = record(limits.hourly, amountAmg, now);
  const d = record(limits.daily, amountAmg, now);
  if (h.delayed || d.delayed) {
    return {
      delayed: true,
      allowedAt: h.allowedAt > d.allowedAt ? h.allowedAt : d.allowedAt,
      reason: h.delayed && d.delayed ? "hourly+daily" : h.delayed ? "hourly" : "daily",
      consumesWindowQuota: true,
    };
  }
  return { delayed: false, allowedAt: now, reason: "none", consumesWindowQuota: true };
}

/**
 * Largest amount that executes immediately at `now`.
 * Zero means every non-zero amount is delayed right now.
 */
export function undelayedCapacity(limits: Limits, now: bigint): bigint {
  const headroom = (l: Limiter) => {
    const a = advance(l, now);
    const free = a.maxPerWindow - a.minted - 1n; // strict `<`
    return free > 0n ? free : 0n;
  };
  const caps = [
    headroom(limits.hourly),
    headroom(limits.daily),
    limits.largeThresholdAmg - 1n, // at or above the threshold it is delayed
  ];
  return caps.reduce((m, c) => (c < m ? c : m));
}

export const amgToUba = (amg: bigint, granularityUba: bigint) => amg * granularityUba;
export const ubaToAmg = (uba: bigint, granularityUba: bigint) => uba / granularityUba;
