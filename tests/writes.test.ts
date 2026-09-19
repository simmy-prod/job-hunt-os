import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configSchema } from "../src/config.js";
import { AppError } from "../src/errors.js";
import type { PageWriter } from "../src/notion-writer.js";
import { Outbox } from "../src/outbox.js";
import { acquireLock } from "../src/lock.js";
import { applyWrites, approveWrite, listWrites, proposeWrite, readWriteCounts, rejectWrite } from "../src/write-workflow.js";
import { approvalProblem, parseWriteRequest, policy, writableFields } from "../src/writes.js";
import type { FieldValues, WritableField, WriteRequest } from "../src/writes.js";
import { root, snapshot } from "./helpers.js";

const temporary = () => mkdtempSync(join(tmpdir(), "job-hunt-writes-"));
const demoConfig = configSchema.parse({schemaVersion: 1, timezone: "Australia/Melbourne",
  source: {driver: "snapshot", path: join(root, "tests/fixtures/snapshot.json")}});
const at = (iso: string) => ({now: () => new Date(iso)});
const clock = at("2026-09-18T00:00:00Z");
const source = () => ({read: async () => snapshot()});

// In-memory stand-in for Notion, seeded from the fictional fixture.
function fakeRemote() {
  const data = snapshot();
  const remote = new Map<string, FieldValues>([
    ...data.targets.map((item) => [item.id, {lastChecked: item.lastChecked}] as const),
    ...data.applications.map((item) => [item.id, {nextAction: item.nextAction, nextActionDate: item.nextActionDate,
      pipelineStage: item.stage, appliedDate: item.appliedDate}] as const),
  ]);
  const calls = {factory: 0, read: 0, write: 0};
  const failures = new Map<string, AppError[]>();
  let respond: ((desired: FieldValues) => FieldValues) | undefined;
  const pick = (id: string, fields: readonly WritableField[]) => Object.fromEntries(fields.map((field) => [field, remote.get(id)?.[field] ?? null]));
  const writer: PageWriter = {
    prepare: async () => { const error = failures.get("prepare")?.shift(); if (error) throw error; },
    read: async (id, fields) => { calls.read++; return pick(id, fields); },
    write: async (id, desired) => {
      calls.write++;
      const error = failures.get(id)?.shift();
      if (error) throw error;
      remote.set(id, {...remote.get(id), ...desired});
      return respond ? respond(desired) : pick(id, Object.keys(desired) as WritableField[]);
    },
  };
  return {
    remote, calls,
    factory: () => { calls.factory++; return writer; },
    fail: (key: string, ...errors: AppError[]) => failures.set(key, errors),
    respondWith: (fn: (desired: FieldValues) => FieldValues) => { respond = fn; },
  };
}

const propose = (dir: string, request: Record<string, unknown>, when = clock) =>
  proposeWrite({config: demoConfig, source, root: dir, clock: when, request: parseWriteRequest(request) as WriteRequest});
const apply = (dir: string, factory: () => PageWriter, when = clock, execute = true) =>
  applyWrites({config: demoConfig, root: dir, clock: when, execute, writer: factory});
const answer = (override?: string) => async (question: string) =>
  question.startsWith("Type SUBMITTED") ? override ?? "SUBMITTED" : question.split(" ")[1]!;
const approve = (dir: string, id: string, options: {attest?: boolean; ask?: (question: string) => Promise<string>} = {}) =>
  approveWrite({root: dir, clock, id, attestSubmitted: options.attest ?? false, prompter: {show: () => {}, ask: options.ask ?? answer()}});
function database(dir: string) { return new DatabaseSync(join(dir, ".runtime/writes.sqlite")); }

test("forbidden operations, fields, and values are refused before any storage exists", () => {
  const dir = temporary();
  for (const request of [
    {operation: "company.rename", recordId: "target-northwind"},
    {operation: "application.set_stage", recordId: "application-example-two", stage: "Applied"},
    {operation: "application.set_stage", recordId: "application-example-two", stage: "Offerr"},
    {operation: "application.set_stage", recordId: "application-example-two", stage: "Screen", company: "Renamed"},
    {operation: "target.mark_checked", recordId: "target-northwind", date: "2026-09-30"},
    {operation: "application.set_next_action", recordId: "application-example-two", action: "line\nbreak", date: "2026-09-20"},
    {operation: "application.set_next_action", recordId: "application-example-two", action: "x".repeat(2001), date: "2026-09-20"},
  ]) assert.throws(() => parseWriteRequest(request), (error: AppError) => error.code === "POLICY");
  assert.equal(existsSync(join(dir, ".runtime")), false);
  const writable = new Set<string>(Object.values(policy).flatMap((rule) => rule.fields));
  assert.deepEqual([...writable].sort(), [...writableFields].sort());
  for (const field of ["company", "watchStatus", "careersUrl", "roleTypes", "role", "sourceUrl", "checkFrequency", "kind"]) {
    assert.equal(writable.has(field), false, field);
  }
});

test("preconditions block backwards dates, future applied dates, and no-op proposals", async () => {
  const dir = temporary();
  await assert.rejects(propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"}, at("2026-09-15T00:00:00Z")), /backwards/);
  await assert.rejects(propose(dir, {operation: "application.confirm_applied", recordId: "application-example-two", date: "2026-09-19"}), /future/);
  await assert.rejects(propose(dir, {operation: "application.confirm_applied", recordId: "application-example-one"}), /Researching/);
  await assert.rejects(propose(dir, {operation: "application.set_stage", recordId: "application-example-two", stage: "Researching"}), /already has/);
  await assert.rejects(propose(dir, {operation: "target.mark_checked", recordId: "missing-target"}), /No target/);
});

test("duplicate proposals collapse to one intent through the idempotency key", async () => {
  const dir = temporary();
  const request = {operation: "target.mark_checked", recordId: "target-northwind"};
  const first = await propose(dir, request);
  const second = await propose(dir, request);
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
  assert.equal(second.intent.id, first.intent.id);
  const db = database(dir);
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM intents").get()?.n, 1);
    assert.deepEqual(db.prepare("SELECT event FROM write_events ORDER BY id").all().map((row) => row.event), ["proposed", "approved", "duplicate"]);
  } finally { db.close(); }
});

test("a runtime-owned write is sent once and a replayed apply sends nothing", async () => {
  const dir = temporary(); const fake = fakeRemote();
  await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  const first = await apply(dir, fake.factory);
  assert.equal(first.ok, true); assert.equal(first.results[0]?.outcome, "applied");
  assert.equal(fake.remote.get("target-northwind")?.lastChecked, "2026-09-18");
  const replay = await apply(dir, fake.factory);
  assert.deepEqual(replay.results, []);
  assert.equal(fake.calls.write, 1);
});

test("dry run never builds a writer, reads a credential, or changes local state", async () => {
  const dir = temporary();
  const {intent} = await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  const count = () => { const db = database(dir); try { return db.prepare("SELECT count(*) AS n FROM write_events").get()?.n; } finally { db.close(); } };
  const before = count();
  const result = await apply(dir, () => { throw new Error("writer must not be built in a dry run"); }, clock, false);
  assert.equal(result.mode, "dry_run"); assert.equal(result.results[0]?.outcome, "would_send");
  assert.equal(count(), before);
  const outbox = new Outbox(dir);
  try { assert.equal(outbox.get(intent.id).state, "approved"); } finally { outbox.close(); }
});

test("human-tier writes wait for an approval with the typed confirmation code", async () => {
  const dir = temporary(); const fake = fakeRemote();
  const {intent} = await propose(dir, {operation: "application.set_next_action", recordId: "application-example-two",
    action: "Email follow-up drafted, send by hand", date: "2026-09-22"});
  assert.equal(intent.state, "awaiting_approval");
  const waiting = await apply(dir, fake.factory);
  assert.equal(waiting.results[0]?.outcome, "awaiting_approval");
  assert.equal(fake.calls.factory, 0);
  await assert.rejects(approve(dir, intent.id, {ask: async () => "wrong-code"}), /did not match/);
  await assert.rejects(approve(dir, intent.id, {attest: true}), /only applies to application.confirm_applied/);
  await approve(dir, intent.id);
  await assert.rejects(approve(dir, intent.id), /not awaiting approval/);
  const applied = await apply(dir, fake.factory);
  assert.equal(applied.results[0]?.outcome, "applied");
  assert.equal(fake.remote.get("application-example-two")?.nextAction, "Email follow-up drafted, send by hand");
});

test("Applied is only reachable through an attested human confirmation", async () => {
  const dir = temporary(); const fake = fakeRemote();
  const {intent} = await propose(dir, {operation: "application.confirm_applied", recordId: "application-example-two"});
  await assert.rejects(approve(dir, intent.id), /--confirm-submitted/);
  await assert.rejects(approve(dir, intent.id, {attest: true, ask: answer("yes")}), /not confirmed/);
  assert.equal((await apply(dir, fake.factory)).results[0]?.reason, "awaiting_approval");
  assert.equal(fake.calls.write, 0);
  await approve(dir, intent.id, {attest: true});
  const result = await apply(dir, fake.factory);
  assert.equal(result.results[0]?.outcome, "applied");
  assert.deepEqual({stage: fake.remote.get("application-example-two")?.pipelineStage, date: fake.remote.get("application-example-two")?.appliedDate},
    {stage: "Applied", date: "2026-09-18"});
});

test("the executor gate rejects any approval that does not carry the right authority", () => {
  const key = "a".repeat(64);
  const applied = {operation: "application.confirm_applied" as const, idempotencyKey: key, desired: {pipelineStage: "Applied"}};
  const stage = {operation: "application.set_stage" as const, idempotencyKey: key, desired: {pipelineStage: "Screen"}};
  assert.equal(approvalProblem(applied, null), "awaiting_approval");
  assert.equal(approvalProblem(applied, {idempotencyKey: "b".repeat(64), method: "human_tty", attestation: "submitted"}), "awaiting_approval");
  assert.equal(approvalProblem(applied, {idempotencyKey: key, method: "human_tty", attestation: null}), "needs_submission_attestation");
  assert.equal(approvalProblem(applied, {idempotencyKey: key, method: "policy", attestation: "submitted"}), "needs_human_approval");
  assert.equal(approvalProblem(stage, {idempotencyKey: key, method: "policy", attestation: null}), "needs_human_approval");
  // Even a human-approved stage change cannot smuggle in Applied.
  assert.equal(approvalProblem({...stage, desired: {pipelineStage: "Applied"}}, {idempotencyKey: key, method: "human_tty", attestation: null}),
    "needs_submission_attestation");
  assert.equal(approvalProblem(stage, {idempotencyKey: key, method: "human_tty", attestation: null}), null);
});

test("a crash after a landed write is reconciled by read-back, never sent twice", async () => {
  const dir = temporary(); const fake = fakeRemote();
  const {intent} = await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  const outbox = new Outbox(dir);
  try { assert.equal(outbox.claim(intent.id, new Date("2026-09-18T00:00:00Z")), true); } finally { outbox.close(); }
  fake.remote.set("target-northwind", {lastChecked: "2026-09-18"});
  const soon = await apply(dir, fake.factory, at("2026-09-18T00:05:00Z"));
  assert.equal(soon.results[0]?.outcome, "skipped_claimed");
  const later = await apply(dir, fake.factory, at("2026-09-18T00:11:00Z"));
  assert.equal(later.results[0]?.outcome, "reconciled");
  assert.equal(fake.calls.write, 0);
});

test("transient failures retry with a bounded attempt count and never report success", async () => {
  const dir = temporary(); const fake = fakeRemote();
  const {intent} = await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  const outage = () => new AppError("NOTION", "synthetic outage");
  fake.fail("target-northwind", outage(), outage());
  assert.equal((await apply(dir, fake.factory)).results[0]?.outcome, "retry");
  const second = await apply(dir, fake.factory);
  assert.equal(second.results[0]?.outcome, "retry"); assert.equal(second.ok, false);
  assert.equal((await apply(dir, fake.factory)).results[0]?.outcome, "applied");
  const outbox = new Outbox(dir);
  try { assert.equal(outbox.get(intent.id).attempts, 2); } finally { outbox.close(); }

  const other = temporary(); const failing = fakeRemote();
  const {intent: doomed} = await propose(other, {operation: "target.mark_checked", recordId: "target-northwind"});
  failing.fail("target-northwind", outage(), outage(), outage());
  for (const expected of ["retry", "retry", "failed"]) assert.equal((await apply(other, failing.factory)).results[0]?.outcome, expected);
  assert.deepEqual((await apply(other, failing.factory)).results, []);
  const box = new Outbox(other);
  try { assert.deepEqual([box.get(doomed.id).state, box.get(doomed.id).lastError], ["failed", "NOTION"]); } finally { box.close(); }
});

test("a partial failure is isolated: other intents still apply and the run reports failure", async () => {
  const dir = temporary(); const fake = fakeRemote();
  for (const recordId of ["target-northwind", "target-meridian", "target-search"]) await propose(dir, {operation: "target.mark_checked", recordId});
  fake.fail("target-meridian", new AppError("NOTION", "synthetic outage"));
  const result = await apply(dir, fake.factory);
  assert.equal(result.ok, false);
  assert.deepEqual(Object.fromEntries(result.results.map((item) => [item.recordId, item.outcome])),
    {"target-northwind": "applied", "target-meridian": "retry", "target-search": "applied"});
  assert.equal(fake.remote.get("target-meridian")?.lastChecked, "2026-09-11");
});

test("schema problems are terminal, and an auth failure stops the run without spending an attempt", async () => {
  const dir = temporary(); const fake = fakeRemote();
  const {intent} = await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  fake.fail("target-northwind", new AppError("AUTH", "synthetic auth"));
  await assert.rejects(apply(dir, fake.factory), /synthetic auth/);
  const outbox = new Outbox(dir);
  try { assert.deepEqual([outbox.get(intent.id).state, outbox.get(intent.id).attempts], ["approved", 0]); } finally { outbox.close(); }
  fake.fail("prepare", new AppError("SCHEMA", "synthetic drift"));
  const result = await apply(dir, fake.factory);
  assert.deepEqual([result.results[0]?.outcome, result.results[0]?.errorCode], ["failed", "SCHEMA"]);
});

test("a concurrent human edit in Notion wins over an approved write", async () => {
  const dir = temporary(); const fake = fakeRemote();
  const {intent} = await propose(dir, {operation: "application.set_stage", recordId: "application-example-two", stage: "Screen"});
  await approve(dir, intent.id);
  fake.remote.set("application-example-two", {...fake.remote.get("application-example-two"), pipelineStage: "Closed"});
  const result = await apply(dir, fake.factory);
  assert.equal(result.results[0]?.outcome, "conflict"); assert.equal(result.ok, false);
  assert.equal(fake.calls.write, 0);
  assert.equal(fake.remote.get("application-example-two")?.pipelineStage, "Closed");
});

test("an unverified provider response is recorded as a failure, not as applied", async () => {
  const dir = temporary(); const fake = fakeRemote();
  const {intent} = await propose(dir, {operation: "target.mark_checked", recordId: "target-search"});
  fake.respondWith(() => ({lastChecked: null}));
  const result = await apply(dir, fake.factory);
  assert.deepEqual([result.results[0]?.outcome, result.results[0]?.errorCode], ["retry", "NOTION"]);
  const outbox = new Outbox(dir);
  try { assert.equal(outbox.get(intent.id).state, "approved"); } finally { outbox.close(); }
});

test("demo intents are scoped to their config and never apply under another source", async () => {
  const dir = temporary(); const fake = fakeRemote();
  await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  const other = configSchema.parse({...demoConfig, source: {driver: "snapshot", path: join(root, "tests/fixtures/other.json")}});
  const result = await applyWrites({config: other, root: dir, clock, execute: true, writer: fake.factory});
  assert.deepEqual(result.results, []); assert.equal(fake.calls.factory, 0);
});

test("rejected intents never send, and audit events stay append-only and value-free", async () => {
  const dir = temporary(); const fake = fakeRemote();
  const sentinel = "PRIVATE_ACTION_SENTINEL";
  const {intent} = await propose(dir, {operation: "application.set_next_action", recordId: "application-example-two", action: sentinel, date: "2026-09-22"});
  rejectWrite({root: dir, clock, id: intent.id});
  assert.throws(() => rejectWrite({root: dir, clock, id: intent.id}), /cannot be rejected/);
  assert.deepEqual((await apply(dir, fake.factory)).results, []);
  await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  const db = database(dir);
  try {
    const events = JSON.stringify(db.prepare("SELECT * FROM write_events").all());
    assert.doesNotMatch(events, new RegExp(`${sentinel}|application-example|Example|token`));
    assert.throws(() => db.prepare("UPDATE write_events SET event = 'applied'").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM write_events").run(), /append-only/);
    assert.throws(() => db.prepare("DELETE FROM approvals").run(), /immutable/);
  } finally { db.close(); }
  assert.doesNotMatch(readFileSync(join(dir, ".runtime/writes.sqlite"), "latin1"), /synthetic-write-token/);
});

test("retention prunes old finished intents and their approvals, never open ones", async () => {
  const dir = temporary(); const fake = fakeRemote();
  const {intent: done} = await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  await apply(dir, fake.factory);
  const {intent: open} = await propose(dir, {operation: "application.set_stage", recordId: "application-example-two", stage: "Screen"});
  // 200 days later: the finished intent and old events go, the open intent stays.
  await apply(dir, fake.factory, at("2027-04-06T00:00:00Z"));
  const db = database(dir);
  try {
    assert.deepEqual(db.prepare("SELECT id FROM intents").all().map((row) => row.id), [open.id]);
    assert.equal(db.prepare("SELECT count(*) AS n FROM approvals WHERE intent_id = ?").get(done.id)?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM write_events WHERE intent_id = ?").get(done.id)?.n, 0);
    // Retention is the only way out: recent events and live approvals still cannot be deleted.
    assert.throws(() => db.prepare("DELETE FROM write_events").run(), /append-only/);
  } finally { db.close(); }
});

test("a finished intent younger than the retention window is kept", async () => {
  const dir = temporary(); const fake = fakeRemote();
  const {intent} = await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  await apply(dir, fake.factory);
  await apply(dir, fake.factory, at("2026-12-01T00:00:00Z"));
  const outbox = new Outbox(dir);
  try { assert.equal(outbox.get(intent.id).state, "applied"); } finally { outbox.close(); }
});

test("an executed apply holds its own writes lock; the dry run and morning lock are unaffected", async () => {
  const dir = temporary(); const fake = fakeRemote();
  await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  const held = acquireLock(dir, "writes");
  try {
    await assert.rejects(apply(dir, fake.factory), (error: AppError) => error.code === "LOCKED" && /writes\.lock/.test(error.message));
    assert.equal(fake.calls.factory, 0);
    assert.equal((await apply(dir, fake.factory, clock, false)).results[0]?.outcome, "would_send");
    acquireLock(dir).release();
  } finally { held.release(); }
  assert.equal((await apply(dir, fake.factory)).results[0]?.outcome, "applied");
  assert.equal(existsSync(join(dir, ".runtime/writes.lock")), false);
});

test("status counts are per config, read-only, and absent before any proposal", async () => {
  const dir = temporary(); const fake = fakeRemote();
  assert.equal(readWriteCounts(dir, demoConfig), null);
  assert.equal(existsSync(join(dir, ".runtime")), false);
  await propose(dir, {operation: "application.set_stage", recordId: "application-example-two", stage: "Screen"});
  await propose(dir, {operation: "target.mark_checked", recordId: "target-meridian"});
  fake.fail("target-meridian", ...Array.from({length: 3}, () => new AppError("NOTION", "synthetic outage")));
  for (let run = 0; run < 3; run++) await apply(dir, fake.factory);
  assert.deepEqual(readWriteCounts(dir, demoConfig), {awaitingApproval: 1, approved: 0, inFlight: 0, failed: 1, conflict: 0});
  // Editing only the schedule block keeps the same scope, like the run key.
  const scheduled = configSchema.parse({...demoConfig, schedule: {enabled: true, time: "08:00"}});
  assert.deepEqual(readWriteCounts(dir, scheduled), readWriteCounts(dir, demoConfig));
});

test("regression: a dry run and writes status on an empty runtime create no local state", async () => {
  const dir = temporary();
  const result = await apply(dir, () => { throw new Error("writer must not be built in a dry run"); }, clock, false);
  assert.deepEqual(result, {mode: "dry_run", ok: true, results: []});
  assert.deepEqual(listWrites(dir), []);
  assert.equal(readWriteCounts(dir, demoConfig), null);
  assert.equal(existsSync(join(dir, ".runtime")), false);
  assert.deepEqual(readdirSync(dir), []);
});

test("a dry run over an existing outbox leaves every runtime file byte-identical", async () => {
  const dir = temporary();
  await propose(dir, {operation: "target.mark_checked", recordId: "target-northwind"});
  await propose(dir, {operation: "application.set_stage", recordId: "application-example-two", stage: "Screen"});
  const snapshotFiles = () => Object.fromEntries(readdirSync(join(dir, ".runtime")).sort().map((name) =>
    [name, createHash("sha256").update(readFileSync(join(dir, ".runtime", name))).digest("hex")]));
  const before = snapshotFiles();
  const result = await apply(dir, () => { throw new Error("writer must not be built in a dry run"); }, clock, false);
  assert.deepEqual(result.results.map((item) => item.outcome).sort(), ["awaiting_approval", "would_send"]);
  listWrites(dir); readWriteCounts(dir, demoConfig);
  assert.deepEqual(snapshotFiles(), before);
  assert.equal(existsSync(join(dir, ".runtime/writes.lock")), false);
});
