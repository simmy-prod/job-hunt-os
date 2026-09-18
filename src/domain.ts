import { z } from "zod";
import { AppError } from "./errors.js";

export const identifier = z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/);
export const dateOnly = z.iso.date();
export const text = z.string().trim().min(1).max(4000);
export const webUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
}, "Expected an HTTP or HTTPS URL without credentials");
export const stage = z.enum(["Researching", "Applied", "Screen", "Interview", "Final", "Offer", "Closed"]);
export const frequency = z.enum(["daily", "weekly"]);
export const targetSchema = z.strictObject({
  id: identifier,
  company: text,
  kind: z.enum(["company", "saved_search"]),
  watchStatus: z.enum(["Active watch", "Paused", "Not a fit"]),
  careersUrl: webUrl.nullable(),
  roleTypes: z.array(text),
  checkFrequency: frequency,
  lastChecked: dateOnly.nullable(),
});
export const applicationSchema = z.strictObject({
  id: identifier,
  company: text,
  role: text.nullable(),
  stage,
  appliedDate: dateOnly.nullable(),
  sourceUrl: webUrl.nullable(),
  nextAction: text.nullable(),
  nextActionDate: dateOnly.nullable(),
});
export const listingSchema = z.strictObject({
  id: identifier,
  sourceId: identifier,
  externalId: identifier,
  title: text,
  company: text,
  canonicalUrl: webUrl,
  locations: z.array(text),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const matchDecisionSchema = z.strictObject({
  listingId: identifier,
  ruleVersion: z.number().int().positive(),
  decision: z.enum(["match", "not_a_match", "needs_review"]),
  reasons: z.array(text).min(1),
});
export const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  targets: z.array(targetSchema),
  applications: z.array(applicationSchema),
}).superRefine((snapshot, ctx) => {
  for (const name of ["targets", "applications"] as const) {
    const seen = new Set<string>();
    snapshot[name].forEach((record, index) => {
      if (seen.has(record.id)) ctx.addIssue({code: "custom", path: [name, index, "id"], message: "Duplicate ID"});
      seen.add(record.id);
    });
  }
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Application = z.infer<typeof applicationSchema>;

export function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Paths identify bad fields without echoing their personal values.
  const paths = result.error.issues.slice(0, 12).map((issue) => issue.path.join(".") || "root");
  throw new AppError("SCHEMA", `${label} failed validation at: ${[...new Set(paths)].join(", ")}. See docs/runtime.md for the contract.`);
}
