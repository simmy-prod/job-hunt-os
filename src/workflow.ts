import { planningConfig } from "./config.js";
import type { Config } from "./config.js";
import { AppError, safeError } from "./errors.js";
import { processIsAlive, RunLedger } from "./ledger.js";
import type { Invoker, Lease } from "./ledger.js";
import { businessDate, hash, planMorning } from "./planner.js";
import type { Plan } from "./planner.js";
import type { SnapshotSource } from "./source.js";

export interface Clock { now(): Date; }

// Longer than any bounded Notion read; only matters if the owner PID is still alive.
export const LEASE_TTL_MS = 30 * 60_000;

export interface RunOptions {
  config: Config;
  source: () => SnapshotSource;
  root: string;
  clock: Clock;
  // The lease uses real time even when `clock` is pinned with --at. Injectable for tests.
  wallClock?: Clock;
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

export function logicalKey(config: Config, now: Date): string {
  return `morning-plan:v1:${hash(planningConfig(config))}:${businessDate(now, config.timezone)}`;
}

export function acquireLease(ledger: RunLedger, options: RunOptions): Lease | undefined {
  return ledger.acquire({now: (options.wallClock ?? {now: () => new Date()}).now(), pid: options.pid ?? process.pid,
    ttlMs: LEASE_TTL_MS, isAlive: options.isAlive ?? processIsAlive});
}

// Reads, plans, and records exactly one outcome for the logical key. The source
// factory runs inside the try, so a credential failure is recorded like any other.
export async function executeRun(ledger: RunLedger, options: RunOptions, now: Date, invoker: Invoker): Promise<Plan> {
  const key = logicalKey(options.config, now);
  try {
    const snapshot = await options.source().read();
    const plan = planMorning(snapshot, now, options.config.timezone);
    ledger.record({logicalKey: key, observedAt: now.toISOString(), plan, invoker});
    return plan;
  } catch (error) {
    const failure = safeError(error);
    ledger.record({logicalKey: key, observedAt: now.toISOString(), errorCode: failure.code, invoker});
    throw failure;
  }
}

export async function runMorning(options: RunOptions & {record: boolean}): Promise<Plan> {
  const now = options.clock.now();
  if (!options.record) {
    try { return planMorning(await options.source().read(), now, options.config.timezone); }
    catch (error) { throw safeError(error); }
  }
  const ledger = new RunLedger(options.root);
  try {
    const lease = acquireLease(ledger, options);
    if (!lease) throw new AppError("LOCKED", "Another recorded morning-plan run is in progress. Retry once it finishes; nothing was recorded.");
    try { return await executeRun(ledger, options, now, "manual"); }
    finally { ledger.release(lease); }
  } finally {
    ledger.close();
  }
}
