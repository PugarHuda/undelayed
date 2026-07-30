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
