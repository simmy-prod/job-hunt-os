import { z } from "zod";
import { dateOnly, identifier, validate } from "./domain.js";
import type { Application, Snapshot, Target } from "./domain.js";
import { AppError } from "./errors.js";
import { hash } from "./planner.js";

// The complete write allowlist. Anything not named here cannot be proposed,
// approved, or sent. See docs/runtime.md "Write contract".
export const operations = [
  "target.mark_checked", "application.set_next_action", "application.set_stage", "application.confirm_applied",
] as const;
export type Operation = typeof operations[number];
export const writableFields = ["lastChecked", "nextAction", "nextActionDate", "pipelineStage", "appliedDate"] as const;
export type WritableField = typeof writableFields[number];
export type FieldValues = Partial<Record<WritableField, string | null>>;
export type Confirmation = "policy" | "human" | "human_submitted";

// Applied is deliberately absent: only confirm_applied can set it.
export const settableStages = ["Researching", "Screen", "Interview", "Final", "Offer", "Closed"] as const;

export const policy: Record<Operation, {record: "target" | "application"; fields: readonly WritableField[]; confirmation: Confirmation}> = {
  "target.mark_checked": {record: "target", fields: ["lastChecked"], confirmation: "policy"},
  "application.set_next_action": {record: "application", fields: ["nextAction", "nextActionDate"], confirmation: "human"},
  "application.set_stage": {record: "application", fields: ["pipelineStage"], confirmation: "human"},
  "application.confirm_applied": {record: "application", fields: ["pipelineStage", "appliedDate"], confirmation: "human_submitted"},
};

const action = z.string().trim().min(1).max(2000).refine((value) => !/\p{Cc}/u.test(value), "Expected one line of text");
export const writeRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({operation: z.literal("target.mark_checked"), recordId: identifier}),
  z.strictObject({operation: z.literal("application.set_next_action"), recordId: identifier, action, date: dateOnly}),
  z.strictObject({operation: z.literal("application.set_stage"), recordId: identifier, stage: z.enum(settableStages)}),
  z.strictObject({operation: z.literal("application.confirm_applied"), recordId: identifier, date: dateOnly.optional()}),
]);
export type WriteRequest = z.infer<typeof writeRequestSchema>;

export interface Intent {
  id: string;
  idempotencyKey: string;
  confirmationCode: string;
  sourceKey: string;
  operation: Operation;
  recordId: string;
  desired: FieldValues;
  expected: FieldValues;
}

export function parseWriteRequest(raw: Record<string, unknown>): WriteRequest {
  if (!operations.includes(raw.operation as Operation)) {
    throw new AppError("POLICY", `Not an allowlisted write operation. Allowed: ${operations.join(", ")}.`);
  }
  if (raw.operation === "application.set_stage" && raw.stage === "Applied") {
    throw new AppError("POLICY", "Applied can only be set by application.confirm_applied after a human confirms the submission.");
  }
  try {
    return validate(writeRequestSchema, raw, "Write request");
  } catch (error) {
    if (error instanceof AppError) throw new AppError("POLICY", error.message);
    throw error;
  }
}

function currentValues(record: Target | Application, fields: readonly WritableField[]): FieldValues {
  const all: FieldValues = "stage" in record
    ? {nextAction: record.nextAction, nextActionDate: record.nextActionDate, pipelineStage: record.stage, appliedDate: record.appliedDate}
    : {lastChecked: record.lastChecked};
  return Object.fromEntries(fields.map((field) => [field, all[field] ?? null]));
}

export function sameValues(fields: readonly WritableField[], left: FieldValues, right: FieldValues): boolean {
  return fields.every((field) => (left[field] ?? null) === (right[field] ?? null));
}

// Rules that must hold both when proposing and immediately before sending.
export function checkPreconditions(operation: Operation, current: FieldValues, desired: FieldValues, today: string): void {
  if (operation === "target.mark_checked" && current.lastChecked && current.lastChecked > (desired.lastChecked ?? "")) {
    throw new AppError("POLICY", "Last Checked would move backwards or is in the future. Review the record by hand.");
  }
  if (operation === "application.confirm_applied") {
    if (current.pipelineStage !== "Researching") throw new AppError("POLICY", "confirm_applied needs the application to be in Researching.");
    if ((desired.appliedDate ?? "") > today) throw new AppError("POLICY", "The applied date cannot be in the future.");
  }
  if (desired.pipelineStage === "Applied" && operation !== "application.confirm_applied") {
    throw new AppError("POLICY", "Applied can only be set by application.confirm_applied.");
  }
}

// Builds an immutable intent. Fields the source has no mapping for are
// dropped, never guessed (appliedDate is optional in the Notion mapping).
export function buildIntent(request: WriteRequest, snapshot: Snapshot, options: {
  sourceKey: string; today: string; mapped: ReadonlySet<WritableField>;
}): Intent {
  const rule = policy[request.operation];
  const records: Array<Target | Application> = rule.record === "target" ? snapshot.targets : snapshot.applications;
  const record = records.find((item) => item.id === request.recordId);
  if (!record) throw new AppError("INPUT", `No ${rule.record} with that id exists in the current source.`);
  const desired: FieldValues = request.operation === "target.mark_checked" ? {lastChecked: options.today}
    : request.operation === "application.set_next_action" ? {nextAction: request.action, nextActionDate: request.date}
      : request.operation === "application.set_stage" ? {pipelineStage: request.stage}
        : {pipelineStage: "Applied", appliedDate: request.date ?? options.today};
  const fields = rule.fields.filter((field) => options.mapped.has(field));
  for (const field of rule.fields) if (!fields.includes(field)) delete desired[field];
  if (!fields.includes(rule.fields[0]!)) throw new AppError("CONFIG", "The source has no mapping for the field this operation writes.");
  const expected = currentValues(record, fields);
  checkPreconditions(request.operation, expected, desired, options.today);
  if (sameValues(fields, expected, desired)) throw new AppError("INPUT", "The record already has these values. Nothing to propose.");
  const idempotencyKey = hash({operation: request.operation, sourceKey: options.sourceKey, recordId: record.id, desired, expected});
  return {
    id: idempotencyKey.slice(0, 12), idempotencyKey, confirmationCode: idempotencyKey.slice(-8),
    sourceKey: options.sourceKey, operation: request.operation, recordId: record.id, desired, expected,
  };
}

export function intentFields(intent: Pick<Intent, "desired">): WritableField[] {
  return writableFields.filter((field) => field in intent.desired);
}

export interface Approval {
  idempotencyKey: string;
  method: "policy" | "human_tty";
  attestation: "submitted" | null;
}

// Re-checked by the executor immediately before every send.
export function approvalProblem(intent: Pick<Intent, "operation" | "idempotencyKey" | "desired">, approval: Approval | null): string | null {
  if (!approval || approval.idempotencyKey !== intent.idempotencyKey) return "awaiting_approval";
  const tier = policy[intent.operation].confirmation;
  if (tier !== "policy" && approval.method !== "human_tty") return "needs_human_approval";
  const setsApplied = intent.desired.pipelineStage === "Applied";
  if ((tier === "human_submitted" || setsApplied) &&
    !(intent.operation === "application.confirm_applied" && approval.method === "human_tty" && approval.attestation === "submitted")) {
    return "needs_submission_attestation";
  }
  return null;
}
