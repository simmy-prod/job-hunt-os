import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AppError } from "./errors.js";

// Far longer than any real morning-plan run against one Notion database.
// Guards against a dead process whose pid was reused by an unrelated program.
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

const lockSchema = z.object({pid: z.number().int().positive(), startedAt: z.number(), token: z.string()});
type LockFile = z.infer<typeof lockSchema>;

export interface Lock { release(): void; }

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function ensureRuntimeDir(root: string): string {
  const directory = join(realpathSync(root), ".runtime");
  try {
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw new Error();
    mkdirSync(directory, {mode: 0o700});
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw new AppError("STORAGE", "Cannot create the private .runtime directory. It must be a local directory, not a symlink.");
    }
  }
  chmodSync(directory, 0o700);
  return directory;
}

function readLock(path: string): LockFile | null {
  try {
    return lockSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function isStale(lock: LockFile): boolean {
  if (Date.now() - lock.startedAt > STALE_LOCK_MS) return true;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    // ESRCH: no such process, safe to recover. EPERM (or anything else): the
    // pid exists under another user and we cannot confirm liveness either
    // way, so treat it conservatively as still held.
    return hasCode(error, "ESRCH");
  }
}

// A process-wide single-instance lock for one workflow, including its remote
// calls. The default "morning" lock covers the morning-plan workflow; writes
// use their own "writes" lock so a write run never blocks a plan. Two
// overlapping invocations of the same workflow must not both reach local
// state or the Notion API at once. Recovers automatically from a lock left
// behind by a process that is no longer running.
export function acquireLock(root: string, name: "morning" | "writes" = "morning"): Lock {
  const directory = ensureRuntimeDir(root);
  const path = join(directory, `${name}.lock`);
  const label = name === "morning" ? "morning-plan" : name;
  const token = randomUUID();
  const tryWrite = (): boolean => {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({pid: process.pid, startedAt: Date.now(), token}));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw new AppError("STORAGE", "Cannot create the run lock. Check permissions on .runtime.");
    }
  };
  if (!tryWrite()) {
    const existing = readLock(path);
    if (existing && isStale(existing)) {
      // Another process may be recovering the same stale lock concurrently;
      // a failed unlink here just means it already did, which is fine.
      try { unlinkSync(path); } catch { /* already recovered */ }
    }
    if (!tryWrite()) {
      throw new AppError("LOCKED", `Another ${label} run holds the lock. Wait for it to finish, or check for a stuck process holding .runtime/${name}.lock.`);
    }
  }
  return {
    release() {
      // Only remove the lock if it is still the one we wrote, so a release
      // never deletes a lock a different process has since legitimately
      // acquired (e.g. after we were the one recovered as stale).
      const current = readLock(path);
      if (current?.token === token) {
        try { unlinkSync(path); } catch { /* already gone */ }
      }
    },
  };
}

// Read-only view of the lock for `schedule status`. Never creates .runtime.
export function inspectLock(root: string): "free" | "held" | "stale" {
  const path = join(realpathSync(root), ".runtime", "morning.lock");
  if (!existsSync(path)) return "free";
  const existing = readLock(path);
  return existing && !isStale(existing) ? "held" : "stale";
}
