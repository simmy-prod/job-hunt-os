import type { Config } from "./config.js";
import { safeError } from "./errors.js";
import { RunLedger } from "./ledger.js";
import { acquireLock } from "./lock.js";
import type { Lock } from "./lock.js";
import { businessDate, hash, planMorning } from "./planner.js";
import type { Plan } from "./planner.js";
import type { SnapshotSource } from "./source.js";

export interface Clock { now(): Date; }

export function logicalKeyPrefix(config: Config): string {
  return `morning-plan:v1:${hash(config)}:`;
}

export async function runMorning(options: {
  config: Config;
  source: () => SnapshotSource;
  root: string;
  clock: Clock;
  record: boolean;
  dryRun?: boolean;
}): Promise<Plan> {
  const now = options.clock.now();
  const day = businessDate(now, options.config.timezone);
  const logicalKey = `${logicalKeyPrefix(options.config)}${day}`;
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
    const snapshot = await options.source().read();
    const plan = planMorning(snapshot, now, options.config.timezone);
    ledger?.record({status: "success", logicalKey, observedAt: now.toISOString(), plan});
    return plan;
  } catch (error) {
    const failure = safeError(error);
    ledger?.record({status: "failed", logicalKey, observedAt: now.toISOString(), errorCode: failure.code});
    throw failure;
  } finally {
    ledger?.close();
    lock?.release();
  }
}
