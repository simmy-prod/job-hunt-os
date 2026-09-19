import { planningConfig } from "./config.js";
import type { Config } from "./config.js";
import { AppError, safeError } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { writableProperties } from "./notion-writer.js";
import type { PageWriter } from "./notion-writer.js";
import { acquireLock } from "./lock.js";
import { Outbox } from "./outbox.js";
import type { StoredIntent, WriteCounts } from "./outbox.js";
import { businessDate, hash } from "./planner.js";
import type { SnapshotSource } from "./source.js";
import type { Clock } from "./workflow.js";
import { approvalProblem, buildIntent, checkPreconditions, intentFields, policy, sameValues, writableFields } from "./writes.js";
import type { WritableField, WriteRequest } from "./writes.js";

export type { WriteCounts };

// Intents are scoped to the planning config they were proposed under, so
// fictional demo proposals can never be applied to the live data source.
// Like the run key, the schedule block is excluded: editing it never orphans intents.
export const sourceKey = (config: Config) => hash(planningConfig(config));

export function readWriteCounts(root: string, config: Config): WriteCounts | null {
  return Outbox.readCounts(root, sourceKey(config));
}

function mappedFields(config: Config): Set<WritableField> {
  return config.source.driver === "notion" ? new Set(writableProperties(config.source).keys()) : new Set(writableFields);
}

export async function proposeWrite(options: {
  config: Config; source: () => SnapshotSource; root: string; clock: Clock; request: WriteRequest;
}): Promise<{intent: StoredIntent; duplicate: boolean}> {
  const now = options.clock.now();
  const snapshot = await options.source().read();
  const intent = buildIntent(options.request, snapshot, {
    sourceKey: sourceKey(options.config), today: businessDate(now, options.config.timezone), mapped: mappedFields(options.config),
  });
  const outbox = new Outbox(options.root);
  try { return outbox.propose(intent, now); } finally { outbox.close(); }
}

export interface Prompter {
  show(line: string): void;
  ask(question: string): Promise<string>;
}

// Approval is a deliberate human act: the caller must supply an interactive
// prompter, and the operator must type the intent's confirmation code.
export async function approveWrite(options: {
  root: string; clock: Clock; id: string; attestSubmitted: boolean; prompter: Prompter;
}): Promise<StoredIntent> {
  const outbox = new Outbox(options.root);
  try {
    const intent = outbox.get(options.id);
    if (intent.state !== "awaiting_approval") throw new AppError("POLICY", `Intent is ${intent.state}, not awaiting approval.`);
    const submitted = policy[intent.operation].confirmation === "human_submitted";
    if (submitted && !options.attestSubmitted) {
      throw new AppError("POLICY", "confirm_applied needs --confirm-submitted: you must confirm you already submitted this application yourself.");
    }
    if (!submitted && options.attestSubmitted) throw new AppError("CONFIG", "--confirm-submitted only applies to application.confirm_applied.");
    const {show, ask} = options.prompter;
    show(`Intent ${intent.id}: ${intent.operation} on ${intent.recordId}`);
    for (const field of intentFields(intent)) {
      show(`  ${field}: ${JSON.stringify(intent.expected[field] ?? null)} -> ${JSON.stringify(intent.desired[field] ?? null)}`);
    }
    if ((await ask(`Type ${intent.confirmationCode} to approve: `)).trim() !== intent.confirmationCode) {
      throw new AppError("POLICY", "Confirmation code did not match. Nothing was approved.");
    }
    if (submitted) {
      show("This records that you already submitted this application by hand. The runtime never submits applications.");
      if ((await ask("Type SUBMITTED to confirm: ")).trim() !== "SUBMITTED") {
        throw new AppError("POLICY", "Submission was not confirmed. Nothing was approved.");
      }
    }
    outbox.approve(intent.id, submitted ? "submitted" : null, options.clock.now());
    return outbox.get(intent.id);
  } finally { outbox.close(); }
}

export function rejectWrite(options: {root: string; clock: Clock; id: string}): StoredIntent {
  const outbox = new Outbox(options.root);
  try {
    outbox.reject(options.id, options.clock.now());
    return outbox.get(options.id);
  } finally { outbox.close(); }
}

export function listWrites(root: string): StoredIntent[] {
  const outbox = new Outbox(root);
  try { return outbox.list(); } finally { outbox.close(); }
}

export type ApplyOutcome = "would_send" | "awaiting_approval" | "skipped_claimed" | "applied" | "reconciled" | "conflict" | "retry" | "failed";
export interface ApplyResult {
  id: string;
  operation: StoredIntent["operation"];
  recordId: string;
  fields: WritableField[];
  outcome: ApplyOutcome;
  reason?: string;
  errorCode?: ErrorCode;
}

// Dry run by default: without execute it never builds a writer, so it never
// reads the write credential, contacts Notion, or changes local state.
export async function applyWrites(options: {
  config: Config; root: string; clock: Clock; execute: boolean; writer: () => PageWriter;
}): Promise<{mode: "dry_run" | "execute"; ok: boolean; results: ApplyResult[]}> {
  // An executed run holds its own writes lock (not the morning-plan lock).
  // The dry run takes no lock, like every other read-only command.
  const lock = options.execute ? acquireLock(options.root, "writes") : undefined;
  let outbox: Outbox | undefined;
  try {
    outbox = new Outbox(options.root);
    if (options.execute) outbox.prune(options.clock.now());
    const results: ApplyResult[] = [];
    let writer: PageWriter | undefined;
    for (const intent of outbox.open(sourceKey(options.config))) {
      const base = {id: intent.id, operation: intent.operation, recordId: intent.recordId, fields: intentFields(intent)};
      const problem = approvalProblem(intent, outbox.approval(intent.id));
      if (problem) { results.push({...base, outcome: "awaiting_approval", reason: problem}); continue; }
      if (!options.execute) { results.push({...base, outcome: "would_send"}); continue; }
      writer ??= options.writer();
      if (!outbox.claim(intent.id, options.clock.now())) { results.push({...base, outcome: "skipped_claimed"}); continue; }
      const result = await applyOne(outbox, writer, intent, options);
      results.push({...base, ...result});
    }
    const ok = results.every((result) => !["conflict", "retry", "failed"].includes(result.outcome));
    return {mode: options.execute ? "execute" : "dry_run", ok, results};
  } finally {
    outbox?.close();
    lock?.release();
  }
}

async function applyOne(outbox: Outbox, writer: PageWriter, intent: StoredIntent, options: {config: Config; clock: Clock}):
  Promise<{outcome: ApplyOutcome; errorCode?: ErrorCode}> {
  const fields = intentFields(intent);
  const now = () => options.clock.now();
  try {
    await writer.prepare(intent.desired);
    // Read back first: this makes crashes, timeouts, and replays safe.
    const current = await writer.read(intent.recordId, fields);
    if (sameValues(fields, current, intent.desired)) { outbox.finish(intent.id, "reconciled", now()); return {outcome: "reconciled"}; }
    if (!sameValues(fields, current, intent.expected)) { outbox.finish(intent.id, "conflict", now()); return {outcome: "conflict"}; }
    checkPreconditions(intent.operation, current, intent.desired, businessDate(now(), options.config.timezone));
    if (approvalProblem(intent, outbox.approval(intent.id))) throw new AppError("POLICY", "Approval no longer matches this intent.");
    outbox.markSent(intent.id, now());
    const written = await writer.write(intent.recordId, intent.desired);
    if (!sameValues(fields, written, intent.desired)) throw new AppError("NOTION", "Notion did not confirm the written values.");
    outbox.finish(intent.id, "applied", now());
    return {outcome: "applied"};
  } catch (error) {
    const failure = safeError(error);
    // Local state is unknown: leave the claim so the next run reconciles by read-back.
    if (failure.code === "STORAGE") throw failure;
    if (failure.code === "AUTH") {
      outbox.fail(intent.id, failure.code, now(), {transient: true, release: true});
      throw failure;
    }
    const state = outbox.fail(intent.id, failure.code, now(), {transient: failure.code === "NOTION"});
    return {outcome: state === "failed" ? "failed" : "retry", errorCode: failure.code};
  }
}
