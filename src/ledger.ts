import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { digest, hash } from "./planner.js";
import type { Plan } from "./planner.js";

export type Invoker = "manual" | "scheduled";
export interface RunRecord {
  logicalKey: string;
  observedAt: string;
  plan?: Plan;
  errorCode?: ErrorCode;
  invoker?: Invoker;
}
export interface RunSummary {
  status: "success" | "failed";
  observedAt: string;
  revision: number;
  errorCode: string | null;
}
export interface Lease { name: string; owner: string; }
export interface LeaseHolder { pid: number; acquiredAt: string; }
export interface LeaseOptions {
  now: Date;
  pid: number;
  ttlMs: number;
  isAlive: (pid: number) => boolean;
}

const MORNING_LEASE = "morning-plan";

function ledgerPaths(root: string): {directory: string; database: string} {
  const directory = join(realpathSync(root), ".runtime");
  return {directory, database: join(directory, "runs.sqlite")};
}

function assertSafeDatabaseFiles(database: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const path = database + suffix;
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || lstatSync(path).nlink !== 1)) throw new Error();
  }
}

// A lease is abandoned when its process is gone (crash, reboot) or it outlived
// any plausible run. PID reuse after a reboot is covered by the age limit.
export function leaseIsStale(holder: LeaseHolder, options: LeaseOptions): boolean {
  const age = options.now.getTime() - Date.parse(holder.acquiredAt);
  return !options.isAlive(holder.pid) || !Number.isFinite(age) || age > options.ttlMs;
}

export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error instanceof Error && "code" in error && error.code === "EPERM"; }
}

export class RunLedger {
  private readonly db: DatabaseSync;
  constructor(root: string) {
    const {directory, database} = ledgerPaths(root);
    try {
      if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error();
      mkdirSync(directory, {mode: 0o700});
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw new AppError("STORAGE", "Cannot create the private .runtime directory. It must be a local directory, not a symlink.");
      }
    }
    let db: DatabaseSync | undefined;
    try {
      chmodSync(directory, 0o700);
      assertSafeDatabaseFiles(database);
      db = new DatabaseSync(database, {timeout: 5_000});
      chmodSync(database, 0o600);
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2) throw new Error();
      db.exec("BEGIN IMMEDIATE");
      if (version === 0) {
        db.exec(`
          CREATE TABLE runs (
            logical_key TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
            observed_at TEXT NOT NULL,
            revision INTEGER NOT NULL,
            plan_hash TEXT,
            plan_json TEXT,
            digest TEXT,
            error_code TEXT
          ) STRICT;
          CREATE TABLE events (
            id INTEGER PRIMARY KEY,
            logical_key TEXT NOT NULL,
            observed_at TEXT NOT NULL,
            outcome TEXT NOT NULL,
            error_code TEXT,
            invoker TEXT
          ) STRICT;`);
      } else if (version === 1) {
        // Version 1 predates scheduling; its events are all manual runs.
        db.exec("ALTER TABLE events ADD COLUMN invoker TEXT; UPDATE events SET invoker = 'manual';");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS leases (
          name TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          pid INTEGER NOT NULL,
          acquired_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 2;
        COMMIT;`);
      this.db = db;
    } catch {
      if (db?.isTransaction) db.exec("ROLLBACK");
      db?.close();
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
      this.db.prepare("INSERT INTO events (logical_key, observed_at, outcome, error_code, invoker) VALUES (?, ?, ?, ?, ?)").run(
        record.logicalKey, record.observedAt, record.plan ? "success" : "failed", record.errorCode ?? null, record.invoker ?? "manual",
      );
      this.db.exec("COMMIT");
    } catch {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw new AppError("STORAGE", "Could not atomically record the run. No successful run was reported.");
    }
  }

  latest(logicalKey: string): RunSummary | undefined {
    return readSummary(this.db, logicalKey);
  }

  failedAttempts(logicalKey: string, invoker: Invoker): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM events WHERE logical_key = ? AND outcome = 'failed' AND invoker = ?")
      .get(logicalKey, invoker)?.n ?? 0);
  }

  // One workflow at a time, manual or scheduled, covering the remote read too.
  acquire(options: LeaseOptions): Lease | undefined {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const row = this.db.prepare("SELECT pid, acquired_at FROM leases WHERE name = ?").get(MORNING_LEASE);
      if (row && !leaseIsStale({pid: Number(row.pid), acquiredAt: String(row.acquired_at)}, options)) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const lease = {name: MORNING_LEASE, owner: randomUUID()};
      this.db.prepare("INSERT OR REPLACE INTO leases VALUES (?, ?, ?, ?)").run(lease.name, lease.owner, options.pid, options.now.toISOString());
      this.db.exec("COMMIT");
      return lease;
    } catch {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw new AppError("STORAGE", "Could not take the private run lease. Check .runtime/ permissions.");
    }
  }

  // Deletes only this owner's lease, so a takeover by a newer run is never undone.
  release(lease: Lease): void {
    try { this.db.prepare("DELETE FROM leases WHERE name = ? AND owner = ?").run(lease.name, lease.owner); }
    catch { /* An unreleased lease becomes stale once this process exits. */ }
  }

  close(): void { this.db.close(); }
}

function readSummary(db: DatabaseSync, logicalKey: string): RunSummary | undefined {
  const row = db.prepare("SELECT status, observed_at, revision, error_code FROM runs WHERE logical_key = ?").get(logicalKey);
  if (!row) return undefined;
  return {status: row.status === "success" ? "success" : "failed", observedAt: String(row.observed_at),
    revision: Number(row.revision), errorCode: row.error_code === null ? null : String(row.error_code)};
}

export interface LedgerView {
  latest?: RunSummary;
  scheduledFailures: number;
  lease?: LeaseHolder;
}

// Read-only view for status reporting. Never creates, migrates, or locks the ledger.
export function inspectLedger(root: string, logicalKey: string): LedgerView {
  const {directory, database} = ledgerPaths(root);
  if (!existsSync(database)) return {scheduledFailures: 0};
  let db: DatabaseSync | undefined;
  try {
    if (lstatSync(directory).isSymbolicLink()) throw new Error();
    assertSafeDatabaseFiles(database);
    db = new DatabaseSync(database, {readOnly: true, timeout: 5_000});
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 1 && version !== 2) throw new Error();
    const view: LedgerView = {scheduledFailures: 0};
    const latest = readSummary(db, logicalKey);
    if (latest) view.latest = latest;
    if (version === 2) {
      view.scheduledFailures = Number(db.prepare("SELECT count(*) AS n FROM events WHERE logical_key = ? AND outcome = 'failed' AND invoker = 'scheduled'")
        .get(logicalKey)?.n ?? 0);
      const lease = db.prepare("SELECT pid, acquired_at FROM leases WHERE name = ?").get(MORNING_LEASE);
      if (lease) view.lease = {pid: Number(lease.pid), acquiredAt: String(lease.acquired_at)};
    }
    return view;
  } catch {
    throw new AppError("STORAGE", "Cannot read the private run ledger. Check file permissions and ledger schema version.");
  } finally {
    db?.close();
  }
}
