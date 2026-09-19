import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { openPrivateDatabase, readPrivateDatabase } from "./storage.js";
import { policy } from "./writes.js";
import type { Approval, FieldValues, Intent, Operation } from "./writes.js";

export type IntentState = "awaiting_approval" | "approved" | "in_flight" | "applied" | "conflict" | "failed" | "rejected";
export type WriteEvent = "proposed" | "duplicate" | "approved" | "rejected" | "claimed" | "sent" | "applied"
  | "reconciled" | "conflict" | "retry" | "failed" | "pruned";
export interface StoredIntent extends Intent {
  state: IntentState;
  attempts: number;
  lastError: ErrorCode | null;
}

export const MAX_ATTEMPTS = 3;
export const CLAIM_TIMEOUT_MS = 10 * 60_000;
// Same split as the run ledger: rows holding field values (intents) go
// sooner than the value-free audit events. Open intents are never pruned.
export const INTENT_RETENTION_DAYS = 90;
export const EVENT_RETENTION_DAYS = 180;
const finishedStates = "('applied', 'rejected', 'conflict', 'failed')";

export interface WriteCounts {
  awaitingApproval: number;
  approved: number;
  inFlight: number;
  failed: number;
  conflict: number;
}

interface Row { [key: string]: unknown }
function toIntent(row: Row): StoredIntent {
  const key = String(row.idempotency_key);
  return {
    id: String(row.id), idempotencyKey: key, confirmationCode: key.slice(-8), sourceKey: String(row.source_key),
    operation: row.operation as Operation, recordId: String(row.record_id),
    desired: JSON.parse(String(row.desired_json)) as FieldValues, expected: JSON.parse(String(row.expected_json)) as FieldValues,
    state: row.state as IntentState, attempts: Number(row.attempts), lastError: (row.last_error ?? null) as ErrorCode | null,
  };
}

// Private outbox for proposed Notion writes. Events never hold field values.
export class Outbox {
  private readonly db: DatabaseSync;
  constructor(root: string) {
    this.db = openPrivateDatabase(root, "writes.sqlite", "write outbox");
    try {
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS intents (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          source_key TEXT NOT NULL,
          operation TEXT NOT NULL,
          record_id TEXT NOT NULL,
          desired_json TEXT NOT NULL,
          expected_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('awaiting_approval', 'approved', 'in_flight', 'applied', 'conflict', 'failed', 'rejected')),
          attempts INTEGER NOT NULL DEFAULT 0,
          claimed_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS approvals (
          intent_id TEXT PRIMARY KEY REFERENCES intents(id),
          idempotency_key TEXT NOT NULL,
          method TEXT NOT NULL CHECK(method IN ('policy', 'human_tty')),
          attestation TEXT CHECK(attestation IS NULL OR attestation = 'submitted'),
          approved_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS write_events (
          id INTEGER PRIMARY KEY,
          intent_id TEXT NOT NULL,
          at TEXT NOT NULL,
          event TEXT NOT NULL,
          error_code TEXT
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS write_events_append_only_update BEFORE UPDATE ON write_events
          BEGIN SELECT RAISE(ABORT, 'write_events is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS approvals_immutable_update BEFORE UPDATE ON approvals
          BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
        -- Version 2: deletes are allowed only for retention. An event can be
        -- deleted only once it is EVENT_RETENTION_DAYS older than the newest
        -- event, and an approval only once its intent has been pruned.
        DROP TRIGGER IF EXISTS write_events_append_only_delete;
        DROP TRIGGER IF EXISTS approvals_immutable_delete;
        CREATE TRIGGER IF NOT EXISTS write_events_retention_only_delete BEFORE DELETE ON write_events
          WHEN OLD.at >= (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', max(at), '-${EVENT_RETENTION_DAYS} days') FROM write_events)
          BEGIN SELECT RAISE(ABORT, 'write_events is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS approvals_retention_only_delete BEFORE DELETE ON approvals
          WHEN EXISTS (SELECT 1 FROM intents WHERE id = OLD.intent_id)
          BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
        PRAGMA user_version = 2;
      `);
    } catch {
      if (this.db.isOpen) this.db.close();
      throw new AppError("STORAGE", "Cannot open the private write outbox. Check file permissions and outbox schema version.");
    }
  }

  private transaction<T>(work: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (error instanceof AppError) throw error;
      throw new AppError("STORAGE", "Could not atomically update the write outbox. No write was reported as applied.");
    }
  }

  private event(intentId: string, event: WriteEvent, at: Date, errorCode: ErrorCode | null = null): void {
    this.db.prepare("INSERT INTO write_events (intent_id, at, event, error_code) VALUES (?, ?, ?, ?)")
      .run(intentId, at.toISOString(), event, errorCode);
  }

  private row(id: string): StoredIntent | null {
    const row = this.db.prepare("SELECT * FROM intents WHERE id = ?").get(id);
    return row ? toIntent(row) : null;
  }

  // The UNIQUE idempotency key turns a repeated proposal into a no-op.
  propose(intent: Intent, now: Date): {intent: StoredIntent; duplicate: boolean} {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM intents WHERE idempotency_key = ?").get(intent.idempotencyKey);
      if (existing) {
        this.event(String(existing.id), "duplicate", now);
        return {intent: toIntent(existing), duplicate: true};
      }
      const runtimeOwned = policy[intent.operation].confirmation === "policy";
      const at = now.toISOString();
      this.db.prepare(`INSERT INTO intents (id, idempotency_key, source_key, operation, record_id, desired_json, expected_json,
        state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        intent.id, intent.idempotencyKey, intent.sourceKey, intent.operation, intent.recordId,
        JSON.stringify(intent.desired), JSON.stringify(intent.expected), runtimeOwned ? "approved" : "awaiting_approval", at, at);
      this.event(intent.id, "proposed", now);
      if (runtimeOwned) {
        this.db.prepare("INSERT INTO approvals VALUES (?, ?, 'policy', NULL, ?)").run(intent.id, intent.idempotencyKey, at);
        this.event(intent.id, "approved", now);
      }
      return {intent: this.row(intent.id)!, duplicate: false};
    });
  }

  get(id: string): StoredIntent {
    const intent = this.row(id);
    if (!intent) throw new AppError("INPUT", "No write intent with that id. Run `npm run writes -- status` to list intents.");
    return intent;
  }

  approval(id: string): Approval | null {
    const row = this.db.prepare("SELECT * FROM approvals WHERE intent_id = ?").get(id);
    return row ? {idempotencyKey: String(row.idempotency_key), method: row.method as Approval["method"],
      attestation: (row.attestation ?? null) as Approval["attestation"]} : null;
  }

  approve(id: string, attestation: "submitted" | null, now: Date): void {
    this.transaction(() => {
      const intent = this.get(id);
      if (intent.state !== "awaiting_approval") throw new AppError("POLICY", `Intent is ${intent.state}, not awaiting approval.`);
      this.db.prepare("INSERT INTO approvals VALUES (?, ?, 'human_tty', ?, ?)").run(id, intent.idempotencyKey, attestation, now.toISOString());
      this.setState(id, "approved", now);
      this.event(id, "approved", now);
    });
  }

  reject(id: string, now: Date): void {
    this.transaction(() => {
      const intent = this.get(id);
      if (!["awaiting_approval", "approved"].includes(intent.state)) throw new AppError("POLICY", `Intent is ${intent.state} and cannot be rejected.`);
      this.setState(id, "rejected", now);
      this.event(id, "rejected", now);
    });
  }

  private setState(id: string, state: IntentState, now: Date, extra = ""): void {
    this.db.prepare(`UPDATE intents SET state = ?, updated_at = ?${extra} WHERE id = ?`).run(state, now.toISOString(), id);
  }

  // Intents an apply run should look at, oldest first.
  open(sourceKey: string): StoredIntent[] {
    return this.db.prepare(`SELECT * FROM intents WHERE source_key = ? AND state IN ('awaiting_approval', 'approved', 'in_flight')
      ORDER BY created_at, id`).all(sourceKey).map(toIntent);
  }

  list(): StoredIntent[] {
    return this.db.prepare("SELECT * FROM intents ORDER BY created_at, id").all().map(toIntent);
  }

  // Atomic claim. A fresh in_flight claim belongs to another run; an old one
  // is abandoned and is resumed (the executor always reads back first).
  claim(id: string, now: Date): boolean {
    return this.transaction(() => {
      const stale = new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString();
      const result = this.db.prepare(`UPDATE intents SET state = 'in_flight', claimed_at = ?, updated_at = ?
        WHERE id = ? AND (state = 'approved' OR (state = 'in_flight' AND claimed_at < ?))`).run(now.toISOString(), now.toISOString(), id, stale);
      if (result.changes !== 1) return false;
      this.event(id, "claimed", now);
      return true;
    });
  }

  markSent(id: string, now: Date): void {
    this.transaction(() => this.event(id, "sent", now));
  }

  finish(id: string, outcome: "applied" | "reconciled" | "conflict", now: Date): void {
    this.transaction(() => {
      this.setState(id, outcome === "conflict" ? "conflict" : "applied", now, ", claimed_at = NULL, last_error = NULL");
      this.event(id, outcome, now);
    });
  }

  // Transient failures go back to approved until MAX_ATTEMPTS; others are terminal.
  // release=true hands the intent back without spending an attempt.
  fail(id: string, code: ErrorCode, now: Date, options: {transient: boolean; release?: boolean}): IntentState {
    return this.transaction(() => {
      const intent = this.get(id);
      const attempts = intent.attempts + (options.release ? 0 : 1);
      const state: IntentState = options.transient && attempts < MAX_ATTEMPTS ? "approved" : "failed";
      this.db.prepare("UPDATE intents SET state = ?, attempts = ?, last_error = ?, claimed_at = NULL, updated_at = ? WHERE id = ?")
        .run(state, attempts, code, now.toISOString(), id);
      this.event(id, state === "failed" ? "failed" : "retry", now, code);
      return state;
    });
  }

  // Retention, run under the writes lock by each executed apply. Finished
  // intents and their approvals go after INTENT_RETENTION_DAYS; events go
  // after EVENT_RETENTION_DAYS. Open intents are never touched.
  prune(now: Date): void {
    this.transaction(() => {
      const cutoff = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
      // The approval trigger only allows deleting an approval whose intent is
      // already gone, so the intent goes first; the foreign key is checked at commit.
      this.db.exec("PRAGMA defer_foreign_keys = ON");
      this.db.prepare(`DELETE FROM intents WHERE state IN ${finishedStates} AND updated_at < ?`).run(cutoff(INTENT_RETENTION_DAYS));
      this.db.prepare("DELETE FROM approvals WHERE intent_id NOT IN (SELECT id FROM intents)").run();
      const oldEvents = this.db.prepare("SELECT count(*) AS n FROM write_events WHERE at < ?").get(cutoff(EVENT_RETENTION_DAYS))?.n;
      if (Number(oldEvents) > 0) {
        // The delete trigger measures age from the newest event, so the
        // retention run records itself first. The log shows that pruning happened.
        this.event("*", "pruned", now);
        this.db.prepare("DELETE FROM write_events WHERE at < ?").run(cutoff(EVENT_RETENTION_DAYS));
      }
    });
  }

  close(): void { this.db.close(); }

  // Read-only counts for `status`. Never creates .runtime or the outbox.
  static readCounts(root: string, sourceKey: string): WriteCounts | null {
    const db = readPrivateDatabase(root, "writes.sqlite", "write outbox");
    if (!db) return null;
    try {
      const counts: WriteCounts = {awaitingApproval: 0, approved: 0, inFlight: 0, failed: 0, conflict: 0};
      const names: Partial<Record<IntentState, keyof WriteCounts>> = {
        awaiting_approval: "awaitingApproval", approved: "approved", in_flight: "inFlight", failed: "failed", conflict: "conflict",
      };
      for (const row of db.prepare("SELECT state, count(*) AS n FROM intents WHERE source_key = ? GROUP BY state").all(sourceKey)) {
        const name = names[row.state as IntentState];
        if (name) counts[name] = Number(row.n);
      }
      return counts;
    } catch {
      throw new AppError("STORAGE", "Cannot read the private write outbox. Check file permissions and outbox schema version.");
    } finally { db.close(); }
  }
}
