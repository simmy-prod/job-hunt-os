import assert from "node:assert/strict";
import { test } from "node:test";
import { configSchema } from "../src/config.js";
import { applicationSchema, listingSchema, matchDecisionSchema, snapshotSchema, targetSchema, validate, workflowRunSchema } from "../src/domain.js";
import { config, snapshot } from "./helpers.js";

test("synthetic domain contracts cover target, application, listing, and decision", () => {
  const data = snapshot();
  assert.ok(targetSchema.parse(data.targets[0]));
  assert.ok(applicationSchema.parse(data.applications[0]));
  assert.ok(listingSchema.parse({id: "example:123", sourceId: "example", externalId: "123", title: "Example role",
    company: "Example Studio", canonicalUrl: "https://jobs.example.org/123", locations: ["Melbourne"], contentHash: "a".repeat(64),
    firstSeenAt: "2026-09-18T00:00:00.000Z", lastSeenAt: "2026-09-18T00:00:00.000Z"}));
  assert.ok(matchDecisionSchema.parse({listingId: "example:123", ruleVersion: 1, decision: "needs_review", reasons: ["Pay is unknown"]}));
});

for (const [field, value] of [
  ["stage", "appllied"], ["appliedDate", "2026-02-30"], ["nextActionDate", "yesterday"],
  ["sourceUrl", "javascript:alert(1)"], ["sourceUrl", "https://user:secret@example.org/job"],
] as const) test(`rejects invalid application ${field}: ${value.split(":")[0]}`, () => {
  const record = {...snapshot().applications[0], [field]: value};
  assert.equal(applicationSchema.safeParse(record).success, false);
});

test("rejects duplicate application IDs but permits two roles at one company", () => {
  const data = snapshot();
  assert.ok(snapshotSchema.safeParse(data).success);
  data.applications.push({...data.applications[0]!});
  assert.equal(snapshotSchema.safeParse(data).success, false);
});
test("rejects unknown configuration keys, invalid timezone, frequency and identifier", () => {
  assert.equal(configSchema.safeParse({...config, timezone: "Mars/Base"}).success, false);
  assert.equal(configSchema.safeParse({...config, apiKey: "private"}).success, false);
  assert.equal(targetSchema.safeParse({...snapshot().targets[0], checkFrequency: "monthly"}).success, false);
  assert.equal(targetSchema.safeParse({...snapshot().targets[0], id: "../private"}).success, false);
});
test("workflow-run schema accepts exactly one of plan/errorCode and rejects ambiguity", () => {
  const base = {logicalKey: "morning-plan:v1:abc123:2026-09-18", observedAt: "2026-09-18T00:00:00.000Z"};
  assert.ok(workflowRunSchema.safeParse({...base, status: "success", plan: {counts: {}}}).success);
  assert.ok(workflowRunSchema.safeParse({...base, status: "failed", errorCode: "NOTION"}).success);
  assert.equal(workflowRunSchema.safeParse({...base, status: "success", plan: {counts: {}}, errorCode: "NOTION"}).success, false);
  assert.equal(workflowRunSchema.safeParse({...base, status: "success"}).success, false);
  assert.equal(workflowRunSchema.safeParse({...base, status: "failed"}).success, false);
  assert.equal(workflowRunSchema.safeParse({...base, status: "failed", plan: {counts: {}}}).success, false);
  assert.equal(workflowRunSchema.safeParse({...base, status: "unknown"}).success, false);
  assert.equal(workflowRunSchema.safeParse({...base, status: "failed", errorCode: "NOT_A_CODE"}).success, false);
});
test("validation diagnostics never echo private values", () => {
  assert.throws(() => validate(applicationSchema, {...snapshot().applications[0], stage: "PRIVATE_SENTINEL"}, "Application"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /stage/);
    assert.doesNotMatch(error.message, /PRIVATE_SENTINEL/);
    return true;
  });
});
