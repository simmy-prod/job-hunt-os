import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { workflowRunSchema, validate } from "./domain.js";
import { AppError } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { digest, hash } from "./planner.js";
import type { Plan } from "./planner.js";

// Mirrors workflowRunSchema (src/domain.ts) but keeps `plan` typed as the
// real Plan for callers; the schema itself treats plan as opaque and only
// enforces that exactly one of plan/errorCode is present.
export type RunRecord =
  | {status: "success"; logicalKey: string; observedAt: string; plan: Plan}
  | {status: "failed"; logicalKey: string; observedAt: string; errorCode: ErrorCode};

export interface LatestRun {
  logicalKey: string;
  status: "success" | "failed";
  observedAt: string;
  revision: number;
  errorCode: ErrorCode | null;
}

// Business-data-bearing `runs` rows are pruned sooner than the already-redacted
// `events` rows. See docs/runtime.md's retention section for the rationale.
export const RUN_RETENTION_DAYS = 90;
export const EVENT_RETENTION_DAYS = 180;

export class RunLedger {
  private readonly db: DatabaseSync;
  constructor(root: string) {
    const directory = join(realpathSync(root), ".runtime");
    const database = join(directory, "runs.sqlite");
    try {
      if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error();
      mkdirSync(directory, {mode: 0o700});
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw new AppError("STORAGE", "Cannot create the private .runtime directory. It must be a local directory, not a symlink.");
      }
    }
    try {
      chmodSync(directory, 0o700);
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        const path = database + suffix;
        if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || lstatSync(path).nlink !== 1)) throw new Error();
      }
      this.db = new DatabaseSync(database, {timeout: 5_000});
      chmodSync(database, 0o600);
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) {
        this.db.close();
        throw new Error();
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          logical_key TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
          observed_at TEXT NOT NULL,
          revision INTEGER NOT NULL,
          plan_hash TEXT,
          plan_json TEXT,
          digest TEXT,
          error_code TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY,
          logical_key TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          outcome TEXT NOT NULL,
          error_code TEXT
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    } catch {
      throw new AppError("STORAGE", "Cannot open the private run ledger. Check file permissions and ledger schema version.");
    }
  }

  record(record: RunRecord): void {
    // Validated before any SQLite statement: an invalid or ambiguous record
    // (both plan and errorCode, or neither) must never reach the ledger.
    validate(workflowRunSchema, record, "Workflow run record");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const previous = this.db.prepare("SELECT revision, plan_hash FROM runs WHERE logical_key = ?").get(record.logicalKey);
      const planHash = record.status === "success" ? hash(record.plan) : null;
      const revision = Number(previous?.revision ?? 0) + (planHash && previous?.plan_hash !== planHash ? 1 : 0);
      this.db.prepare(`INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(logical_key) DO UPDATE SET status=excluded.status, observed_at=excluded.observed_at,
          revision=excluded.revision, plan_hash=excluded.plan_hash, plan_json=excluded.plan_json,
          digest=excluded.digest, error_code=excluded.error_code`).run(
        record.logicalKey, record.status, record.observedAt, revision,
        planHash, record.status === "success" ? JSON.stringify(record.plan) : null,
        record.status === "success" ? digest(record.plan) : null,
        record.status === "failed" ? record.errorCode : null,
      );
      // Events intentionally contain no target names, URLs, tokens, notes, or raw errors.
      this.db.prepare("INSERT INTO events (logical_key, observed_at, outcome, error_code) VALUES (?, ?, ?, ?)").run(
        record.logicalKey, record.observedAt, record.status, record.status === "failed" ? record.errorCode : null,
      );
      // Retention runs in the same transaction as every write, so the ledger
      // never grows unboundedly and pruning is atomic with the record it rides in on.
      const referenceTime = Date.parse(record.observedAt);
      if (Number.isFinite(referenceTime)) {
        const cutoff = (days: number) => new Date(referenceTime - days * 86_400_000).toISOString();
        this.db.prepare("DELETE FROM runs WHERE observed_at < ?").run(cutoff(RUN_RETENTION_DAYS));
        this.db.prepare("DELETE FROM events WHERE observed_at < ?").run(cutoff(EVENT_RETENTION_DAYS));
      }
      this.db.exec("COMMIT");
    } catch {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw new AppError("STORAGE", "Could not atomically record the run. No successful run was reported.");
    }
  }

  close(): void { this.db.close(); }

  // Read-only: never creates .runtime or the ledger file. Used by `status`,
  // which must not have a side effect just from being run.
  static readLatest(root: string, logicalKeyPrefix: string): LatestRun | null {
    const directory = join(realpathSync(root), ".runtime");
    const database = join(directory, "runs.sqlite");
    if (!existsSync(database)) return null;
    try {
      if (lstatSync(directory).isSymbolicLink()) throw new Error();
      if (lstatSync(database).isSymbolicLink() || !lstatSync(database).isFile() || lstatSync(database).nlink !== 1) throw new Error();
      const db = new DatabaseSync(database, {readOnly: true, timeout: 5_000});
      try {
        // logicalKeyPrefix is derived internally from a hex config hash; it
        // contains no LIKE wildcard characters.
        const row = db.prepare(
          "SELECT logical_key, status, observed_at, revision, error_code FROM runs WHERE logical_key LIKE ? ORDER BY observed_at DESC LIMIT 1",
        ).get(`${logicalKeyPrefix}%`);
        if (!row) return null;
        return {
          logicalKey: String(row.logical_key),
          status: row.status === "failed" ? "failed" : "success",
          observedAt: String(row.observed_at),
          revision: Number(row.revision),
          errorCode: (row.error_code as ErrorCode | null | undefined) ?? null,
        };
      } finally {
        db.close();
      }
    } catch {
      throw new AppError("STORAGE", "Cannot read the private run ledger. Check file permissions and ledger schema version.");
    }
  }
}
