/**
 * Shared state for more than one executor process.
 *
 * The bot kept its state in a JSON file it read at startup and rewrote whenever
 * something happened. One process, that is fine. Two — one per tag, or one
 * restarted while the old one drains — and it is a way to lose money:
 *
 *   - Both read the file, both see no request for a payment, and both buy an
 *     attestation. The second one is money for nothing.
 *   - The last writer wins, so whichever saves second erases the other's record
 *     of a proof it already paid for. That proof is now unfindable and will be
 *     bought a third time.
 *
 * So: one file per payment instead of one file for everything, and the claim is
 * the file's creation. `wx` fails if the path exists, and on every platform that
 * is a single atomic operation — which is the whole mechanism. A process that
 * loses the race does not touch the payment at all.
 *
 * ponytail: a directory of small files, not a database. It survives restarts,
 * needs no daemon, and the failure mode is a stale lock rather than corruption.
 * Move to something shared if executors ever run on different machines.
 */
import { readFileSync, writeFileSync, openSync, closeSync, readdirSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import type { Entry } from "./attempt.js";

/** How long a claim is honoured before another process may take it over. */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

type Record_ = Entry & { claimedBy?: string; claimedAt?: number };

export class Ledger {
  constructor(
    private dir: string,
    private who: string = `${process.pid}`,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private file(txId: string) {
    // The id is a 0x hash, so this cannot escape the directory — but assert it
    // rather than trust it, since the value comes off the network.
    if (!/^0x[0-9a-f]{64}$/i.test(txId)) throw new Error(`not a transaction id: ${txId}`);
    return path.join(this.dir, `${txId.toLowerCase()}.json`);
  }

  read(txId: string): Record_ | null {
    const f = this.file(txId);
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as Record_;
    } catch {
      // A half-written file is not a reason to stop; treat it as unclaimed.
      return null;
    }
  }

  /**
   * Take this payment, or report that somebody else has it.
   *
   * Creating the file IS the claim: `wx` fails if it already exists, and that
   * failure is what stops two processes from both buying a proof.
   */
  claim(txId: string): { ok: true; entry: Record_ } | { ok: false; heldBy: string } {
    const f = this.file(txId);
    const now = Date.now();
    try {
      const fd = openSync(f, "wx");
      closeSync(fd);
      const entry: Record_ = { claimedBy: this.who, claimedAt: now };
      writeFileSync(f, JSON.stringify(entry, null, 2));
      return { ok: true, entry };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }

    const held = this.read(txId);
    if (held?.done) return { ok: false, heldBy: "finished" };
    if (held?.claimedBy === this.who) return { ok: true, entry: held };

    // A crashed process leaves a claim nobody will ever release. After the TTL
    // it is fair game — and taking it over is safe because the record it left
    // behind still holds the request it paid for, so the proof is reused rather
    // than bought again.
    const age = now - (held?.claimedAt ?? 0);
    if (age > CLAIM_TTL_MS) {
      const taken: Record_ = { ...(held ?? {}), claimedBy: this.who, claimedAt: now };
      writeFileSync(f, JSON.stringify(taken, null, 2));
      return { ok: true, entry: taken };
    }
    return { ok: false, heldBy: held?.claimedBy ?? "unknown" };
  }

  /** Record progress. Keeps the claim, so a long wait does not lose the payment. */
  save(txId: string, entry: Entry) {
    const held = this.read(txId);
    writeFileSync(
      this.file(txId),
      JSON.stringify({ ...entry, claimedBy: this.who, claimedAt: held?.claimedAt ?? Date.now() }, null, 2),
    );
  }

  /** Every payment this ledger knows about, across processes. */
  all(): Array<{ txId: string; entry: Record_ }> {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ txId: f.replace(/\.json$/, ""), entry: this.read(f.replace(/\.json$/, "")) }))
      .filter((r): r is { txId: string; entry: Record_ } => r.entry !== null);
  }

  /**
   * Books across every process, which is the point of sharing the directory: two
   * executors serving different tags still add up to one business.
   */
  totals() {
    const rows = this.all().map((r) => r.entry);
    const won = rows.filter((e) => e.outcome === "won");
    const lost = rows.filter((e) => e.outcome === "lost");
    return {
      won: won.length,
      lost: lost.length,
      pending: rows.filter((e) => !e.done).length,
      unlabelled: rows.filter((e) => e.done && !e.outcome).length,
      earnedUba: won.reduce((a, e) => a + BigInt(e.feeUba ?? 0), 0n),
      workers: new Set(rows.map((e) => e.claimedBy).filter(Boolean)).size,
    };
  }

  /** Only for tests and operators clearing a wedged payment. */
  release(txId: string) {
    const f = this.file(txId);
    if (existsSync(f)) unlinkSync(f);
  }
}

/**
 * Migrates the old single-file state so an upgrade does not re-buy every proof
 * the previous version had already paid for.
 */
export function importLegacyState(ledger: Ledger, legacyFile: string): number {
  if (!existsSync(legacyFile)) return 0;
  let parsed: Record<string, Entry>;
  try {
    parsed = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch {
    return 0;
  }
  let moved = 0;
  for (const [txId, entry] of Object.entries(parsed)) {
    if (!/^0x[0-9a-f]{64}$/i.test(txId)) continue;
    if (ledger.read(txId)) continue; // already migrated
    ledger.save(txId, entry);
    moved++;
  }
  return moved;
}

/**
 * A record a merchant could actually choose an executor on.
 *
 * `totals()` answers "was this worth running" for the operator. This answers a
 * different question, asked by someone else: *should I point my tag at you?*
 * The honest form of that answer is not a win rate — it is how long merchants
 * waited, including the times we lost and they waited for somebody else.
 *
 * Deliberately publishable: no transaction ids of payments we did not finalise,
 * no amounts beyond the fees we ourselves earned, and the losses are in it. An
 * executor record that only lists wins is an advert.
 */
export type PublicRecord = {
  executor: string;
  network: string;
  generatedAt: string;
  finalised: number;
  lostRaces: number;
  /** Payments seen and not yet finished, which is a cost to the merchant too. */
  outstanding: number;
  winRatePct: number | null;
  earnedXrp: number;
  /** Tags served, so a merchant can see whether they are one of many or one of two. */
  tags: string[];
};

export function publicRecord(ledger: Ledger, executor: string, network: string, at: string): PublicRecord {
  const rows = ledger.all().map((r) => r.entry);
  const won = rows.filter((e) => e.outcome === "won");
  const lost = rows.filter((e) => e.outcome === "lost");
  const decided = won.length + lost.length;
  return {
    executor,
    network,
    generatedAt: at,
    finalised: won.length,
    lostRaces: lost.length,
    outstanding: rows.filter((e) => !e.done).length,
    // Null rather than 0% or 100% on an empty record: a rate computed from
    // nothing is a claim, and this file is meant to be evidence.
    winRatePct: decided === 0 ? null : Math.round((100 * won.length) / decided),
    earnedXrp: Number(won.reduce((a, e) => a + BigInt(e.feeUba ?? 0), 0n)) / 1e6,
    tags: [...new Set(rows.map((e) => e.tag).filter((t): t is string => Boolean(t)))].sort(),
  };
}

/** How long a finished payment stays before pruning can remove it. */
export const KEEP_FINISHED_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remove finished payments older than the retention window.
 *
 * One file per payment is right and it grows without end. Not a problem yet —
 * a busy executor might see a few thousand a year — but `all()` reads every one
 * of them on every `--report`, so the cost is paid on each call rather than
 * once.
 *
 * Only FINISHED entries are eligible, and that is the whole safety argument:
 * pruning an unfinished payment would forget a proof we paid for, and the next
 * tick would buy another. An entry still holding a request is never touched, no
 * matter how old — a payment stuck for a month is a bug to look at, not
 * rubbish to sweep up.
 *
 * Returns what it removed, so a caller can say so rather than delete quietly.
 */
export function prune(ledger: Ledger, olderThanMs = KEEP_FINISHED_MS, now = Date.now()): string[] {
  const removed: string[] = [];
  for (const { txId, entry } of ledger.all()) {
    if (!entry.done) continue;
    // No timestamp means it predates claim tracking. Keeping it costs one file.
    if (!entry.claimedAt) continue;
    if (now - entry.claimedAt < olderThanMs) continue;
    ledger.release(txId);
    removed.push(txId);
  }
  return removed;
}
