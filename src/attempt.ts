/**
 * One payment, from "we have decided to act on it" to "we know how it ended".
 *
 * This was inline in the bot's loop, which meant the two rules that cost real
 * money had no test at all:
 *
 *   1. A proof is paid for once. The FDC request is recorded and reused across
 *      every later attempt, so an executor that comes back an hour later for a
 *      delayed minting does not buy a second one.
 *   2. A lost race is over. `PaymentAlreadyConfirmed` means another executor
 *      finalised it; the merchant has their FXRP and we cannot ever win. Retry
 *      it and you pay gas forever for a call that can never succeed.
 *
 * Everything the outside world does is injected, so the sequence can be tested
 * without a chain, an XRPL, or an FDC.
 */
import { fees, type FeeConfig } from "./fees.js";

/** PaymentAlreadyConfirmed() — someone else finalised this payment. */
export const ALREADY_CONFIRMED = "0x18dce79f";

export type Entry = {
  request?: string;
  votingRound?: number;
  done?: boolean;
  allowedAt?: number;
  outcome?: "won" | "lost";
  feeUba?: string;
  tag?: string;
};

export type Deps = {
  /** Buys an attestation. Must not be called when the entry already has one. */
  requestProof: () => Promise<{ request: string; votingRound: number }>;
  fetchProof: (votingRound: number, request: string) => Promise<unknown>;
  /** Throws with the revert reason in its message. */
  simulate: (proof: unknown) => Promise<void>;
  execute: (proof: unknown) => Promise<string>;
  save: (entry: Entry) => void;
  log?: (message: string) => void;
};

export type Attempted =
  | { outcome: "won"; entry: Entry; hash: string; feeUba: bigint }
  | { outcome: "lost"; entry: Entry; reason: string }
  | { outcome: "deferred"; entry: Entry; reason: string };

export async function attemptPayment(
  entry: Entry,
  amountUba: bigint,
  cfg: FeeConfig,
  deps: Deps,
): Promise<Attempted> {
  const log = deps.log ?? (() => {});
  const next: Entry = { ...entry };

  if (!next.request) {
    const bought = await deps.requestProof();
    next.request = bought.request;
    next.votingRound = bought.votingRound;
    // Saved before anything else can fail: a request paid for and forgotten is
    // paid for twice.
    deps.save(next);
    log(`attestation requested, round ${bought.votingRound}`);
  }

  const proof = await deps.fetchProof(next.votingRound!, next.request!);

  // Simulate first. A revert costs gas; finding out for free does not.
  try {
    await deps.simulate(proof);
  } catch (e: any) {
    const reason = `${e?.shortMessage ?? e?.message ?? e}`;
    if (reason.includes(ALREADY_CONFIRMED)) {
      const done = { ...next, done: true, outcome: "lost" as const };
      deps.save(done);
      log("another executor won the race — minted already, fee lost");
      return { outcome: "lost", entry: done, reason };
    }
    // Anything else may pass later — a delay that has not elapsed, a proof the
    // round has not finalised. Keep the request; do not mark it done.
    log(`not executable — ${reason}`);
    return { outcome: "deferred", entry: next, reason };
  }

  const hash = await deps.execute(proof);
  // What we earned is the fee the split actually pays, not the setting: on a
  // payment squeezed between the two fees the executor is the one who goes short.
  const feeUba = fees(amountUba, cfg).executorFeeUba;
  const done = { ...next, done: true, outcome: "won" as const, feeUba: String(feeUba) };
  deps.save(done);
  return { outcome: "won", entry: done, hash, feeUba };
}
