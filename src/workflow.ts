import type { Config } from "./config.js";
import { safeError } from "./errors.js";
import { RunLedger } from "./ledger.js";
import { businessDate, hash, planMorning } from "./planner.js";
import type { Plan } from "./planner.js";
import type { SnapshotSource } from "./source.js";

export interface Clock { now(): Date; }

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
  const logicalKey = `morning-plan:v1:${hash(options.config)}:${day}`;
  // dryRun wins even if record is also true, so the "never writes" guarantee
  // does not depend on the caller passing exactly one flag correctly.
  const ledger = options.record && !options.dryRun ? new RunLedger(options.root) : undefined;
  try {
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
  }
}
