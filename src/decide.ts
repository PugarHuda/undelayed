/**
 * What the executor should do about one payment, as a pure function.
 *
 * This logic used to live inline in the bot's loop, where it could not be
 * tested — and it is the part that spends money. Every wrong answer has a
 * price: acting on someone else's exclusive tag burns an FDC proof and gas on a
 * call that reverts, retrying a delayed minting burns the same, and skipping a
 * payment whose executor never showed up leaves a merchant unpaid.
 *
 * The bot supplies the facts; this decides. No network, no clock of its own.
 */

export type DelayState = 0 | 1 | 2; // NotDelayed | Delayed | Released

export type Facts = {
  /** Zero address when the tag is not registered. */
  recipient: string;
  /** Zero address when anyone may execute. */
  allowedExecutor: string;
  /** Us. */
  me: string;
  /** Chain time, from the block the snapshot was pinned to. */
  now: bigint;
  /** The payment's own XRPL ledger time, already in Unix seconds. Null if absent. */
  paidAt: bigint | null;
  /** getDirectMintingOthersCanExecuteAfterSeconds(). */
  exclusiveFor: bigint;
  /** directMintingDelayState() for this payment. */
  delayState: DelayState;
  /** allowedAt from the same call. */
  allowedAt: bigint;
  /** True once we have seen this payment finalised, by us or by anyone. */
  finished: boolean;
};

export type Decision =
  | { action: "execute" }
  | { action: "skip"; why: string }
  | { action: "wait"; until: bigint; why: string };

const ZERO = "0x0000000000000000000000000000000000000000";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function decide(f: Facts): Decision {
  if (f.finished) return { action: "skip", why: "already finished" };
  if (same(f.recipient, ZERO)) return { action: "skip", why: "tag is not registered" };

  // Someone else's exclusive window. It expires, and afterwards the rail is
  // permissionless again — so this is a wait, not a skip.
  if (!same(f.allowedExecutor, ZERO) && !same(f.allowedExecutor, f.me)) {
    if (f.paidAt === null) {
      // Without the payment's ledger time there is no way to know whether the
      // window closed. Waiting costs a poll; guessing wrong costs a proof.
      return { action: "wait", until: f.now, why: "no ledger time on the payment" };
    }
    const opensAt = f.paidAt + f.exclusiveFor;
    if (f.now < opensAt) {
      return { action: "wait", until: opensAt, why: `reserved for ${f.allowedExecutor}` };
    }
  }

  // A delayed minting is a delay, not a failure. Calling before allowedAt
  // reverts DirectMintingStillDelayed and spends the proof for nothing.
  if (f.delayState === 1 && f.now < f.allowedAt) {
    return { action: "wait", until: f.allowedAt, why: "rate-limited, not failed" };
  }

  return { action: "execute" };
}
