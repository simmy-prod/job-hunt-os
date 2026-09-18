import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { digest, hash } from "./planner.js";
import type { Plan } from "./planner.js";

export interface RunRecord {
  logicalKey: string;
  observedAt: string;
  plan?: Plan;
  errorCode?: ErrorCode;
}

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
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const previous = this.db.prepare("SELECT revision, plan_hash FROM runs WHERE logical_key = ?").get(record.logicalKey);
      const planHash = record.plan ? hash(record.plan) : null;
      const revision = Number(previous?.revision ?? 0) + (planHash && previous?.plan_hash !== planHash ? 1 : 0);
      this.db.prepare(`INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(logical_key) DO UPDATE SET status=excluded.status, observed_at=excluded.observed_at,
          revision=excluded.revision, plan_hash=excluded.plan_hash, plan_json=excluded.plan_json,
          digest=excluded.digest, error_code=excluded.error_code`).run(
        record.logicalKey, record.plan ? "success" : "failed", record.observedAt, revision,
        planHash, record.plan ? JSON.stringify(record.plan) : null, record.plan ? digest(record.plan) : null, record.errorCode ?? null,
      );
      // Events intentionally contain no target names, URLs, tokens, notes, or raw errors.
      this.db.prepare("INSERT INTO events (logical_key, observed_at, outcome, error_code) VALUES (?, ?, ?, ?)").run(
        record.logicalKey, record.observedAt, record.plan ? "success" : "failed", record.errorCode ?? null,
      );
      this.db.exec("COMMIT");
    } catch {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw new AppError("STORAGE", "Could not atomically record the run. No successful run was reported.");
    }
  }

  close(): void { this.db.close(); }
}
