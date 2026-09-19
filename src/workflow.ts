import { planningConfig } from "./config.js";
import type { Config } from "./config.js";
import { safeError } from "./errors.js";
import { RunLedger } from "./ledger.js";
import type { Invoker } from "./ledger.js";
import { acquireLock } from "./lock.js";
import type { Lock } from "./lock.js";
import { businessDate, hash, planMorning } from "./planner.js";
import type { Plan } from "./planner.js";
import type { SnapshotSource } from "./source.js";

export interface Clock { now(): Date; }

// Hashes only the planning fields, so editing the `schedule` block never forks
// a day's logical run key or orphans the history `status` reads.
export function logicalKeyPrefix(config: Config): string {
  return `morning-plan:v1:${hash(planningConfig(config))}:`;
}

export function logicalKey(config: Config, now: Date): string {
  return `${logicalKeyPrefix(config)}${businessDate(now, config.timezone)}`;
}

export interface RunOptions {
  config: Config;
  source: () => SnapshotSource;
  root: string;
  clock: Clock;
}

// Reads, plans, and records exactly one outcome for the logical key. Callers
// hold the run lock. The source factory runs inside the try, so a credential
// failure is recorded like any other failure.
export async function executeRun(ledger: RunLedger | undefined, options: RunOptions, now: Date, invoker: Invoker): Promise<Plan> {
  const key = logicalKey(options.config, now);
  try {
    const snapshot = await options.source().read();
    const plan = planMorning(snapshot, now, options.config.timezone);
    ledger?.record({status: "success", logicalKey: key, observedAt: now.toISOString(), plan}, invoker);
    return plan;
  } catch (error) {
    const failure = safeError(error);
    ledger?.record({status: "failed", logicalKey: key, observedAt: now.toISOString(), errorCode: failure.code}, invoker);
    throw failure;
  }
}

export async function runMorning(options: RunOptions & {record: boolean; dryRun?: boolean}): Promise<Plan> {
  const now = options.clock.now();
  businessDate(now, options.config.timezone);
  // The lock (and the ledger it protects) is only engaged when this run would
  // actually touch local state. dryRun wins even if record is also true, for
  // the same reason it wins for the ledger: the "never writes" guarantee must
  // not depend on the caller passing exactly one flag correctly.
  const active = options.record && !options.dryRun;
  let lock: Lock | undefined;
  let ledger: RunLedger | undefined;
  try {
    // Both acquisitions happen inside the try so that a failure between them
    // (the lock is taken, but the ledger then fails to open) still reaches
    // the finally below and releases whatever was actually acquired, instead
    // of leaking .runtime/morning.lock for a run that never got as far as
    // starting the workflow it was meant to guard.
    lock = active ? acquireLock(options.root) : undefined;
    ledger = active ? new RunLedger(options.root) : undefined;
    return await executeRun(ledger, options, now, "manual");
  } catch (error) {
    throw safeError(error);
  } finally {
    ledger?.close();
    lock?.release();
  }
}
