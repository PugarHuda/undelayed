/**
 * Argument parsing for the checkout, as pure functions.
 *
 * These sit in front of a command that moves money, and the failures they catch
 * are the quiet ones: `--usd` with no value took the next flag as its argument
 * and died deep inside BigInt() with "The number NaN cannot be converted"; a
 * negative destination tag sailed through to a field that is a uint32.
 */

/** XRPL destination tags are uint32. Anything else is not a tag. */
export function parseTag(raw: string | undefined): number {
  // Plain decimal only. Number() would read "0x205" as 517, and a tag has to be
  // the same integer the merchant registered on-chain — a base mix-up sends the
  // payment to a tag that is not theirs, or to nobody.
  const decimal = raw !== undefined && /^\d+$/.test(raw.trim());
  const n = Number(raw);
  if (!decimal || !Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new Error(
      `${JSON.stringify(raw ?? "")} is not a destination tag — expected a whole number from 0 to 4294967295`,
    );
  }
  return n;
}

/**
 * An amount in XRP. `what` names the flag so the message says which one.
 *
 * A value starting with "-" is almost always the next flag rather than a
 * negative amount — `--usd --quote` is the case that crashed — so it is called
 * out as a missing value instead of an out-of-range number.
 */
export function parseAmount(raw: string | undefined, what: string): number {
  if (raw === undefined || raw.trim() === "" || raw.startsWith("--")) {
    throw new Error(`${what} needs a value`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${JSON.stringify(raw)} is not a positive amount for ${what}`);
  }
  return n;
}
