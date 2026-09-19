import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RunLedger } from "../src/ledger.js";
import { AppError } from "../src/errors.js";
import type { RunRecord } from "../src/ledger.js";

const temporary = () => mkdtempSync(join(tmpdir(), "job-hunt-ledger-"));
const base = {logicalKey: "morning-plan:v1:abc123:2026-09-18", observedAt: "2026-09-18T00:00:00.000Z"};
const validPlan = {schemaVersion: 1 as const, mode: "read_only" as const, date: "2026-09-18", timezone: "Australia/Melbourne",
  dueTargets: [], followUps: [], reviews: [], counts: {targets: 0, applications: 0, dueTargets: 0, followUps: 0, reviews: 0}};

function tableCounts(root: string) {
  const db = new DatabaseSync(join(root, ".runtime/runs.sqlite"), {readOnly: true});
  try {
    return {
      runs: db.prepare("SELECT count(*) AS n FROM runs").get()?.n,
      events: db.prepare("SELECT count(*) AS n FROM events").get()?.n,
    };
  } finally { db.close(); }
}

test("an ambiguous record (both plan and errorCode) is rejected before touching SQLite", () => {
  const root = temporary();
  const ledger = new RunLedger(root);
  try {
    const ambiguous = {...base, status: "success", plan: {counts: {}}, errorCode: "NOTION"} as unknown as RunRecord;
    assert.throws(() => ledger.record(ambiguous), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "SCHEMA");
      return true;
    });
    assert.deepEqual(tableCounts(root), {runs: 0, events: 0});
  } finally { ledger.close(); }
});
test("a record with neither plan nor errorCode is rejected before touching SQLite", () => {
  const root = temporary();
  const ledger = new RunLedger(root);
  try {
    const incomplete = {...base, status: "success"} as unknown as RunRecord;
    assert.throws(() => ledger.record(incomplete), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "SCHEMA");
      return true;
    });
    assert.deepEqual(tableCounts(root), {runs: 0, events: 0});
  } finally { ledger.close(); }
});
test("a well-formed success record still records normally", () => {
  const root = temporary();
  const ledger = new RunLedger(root);
  try {
    ledger.record({...base, status: "success", plan: validPlan});
    assert.deepEqual(tableCounts(root), {runs: 1, events: 1});
  } finally { ledger.close(); }
});
test("retention prunes rows older than the configured windows, atomically with the next write", () => {
  const root = temporary();
  new RunLedger(root).close();
  const oldObservedAt = new Date("2020-01-01T00:00:00.000Z").toISOString();
  const raw = new DatabaseSync(join(root, ".runtime/runs.sqlite"));
  try {
    raw.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "morning-plan:v1:old:2020-01-01", "success", oldObservedAt, 1, "hash", JSON.stringify(validPlan), "digest", null,
    );
    raw.prepare("INSERT INTO events (logical_key, observed_at, outcome, error_code) VALUES (?, ?, ?, ?)").run(
      "morning-plan:v1:old:2020-01-01", oldObservedAt, "success", null,
    );
  } finally { raw.close(); }
  const ledger = new RunLedger(root);
  try {
    ledger.record({...base, status: "success", plan: validPlan});
  } finally { ledger.close(); }
  const check = new DatabaseSync(join(root, ".runtime/runs.sqlite"), {readOnly: true});
  try {
    assert.deepEqual(check.prepare("SELECT logical_key FROM runs").all().map((row) => row.logical_key), [base.logicalKey]);
    assert.equal(check.prepare("SELECT count(*) AS n FROM events").get()?.n, 1);
  } finally { check.close(); }
});
test("readLatest returns null without creating .runtime for a configuration that has never run", () => {
  const root = temporary();
  assert.equal(RunLedger.readLatest(root, "morning-plan:v1:abc123:"), null);
  assert.equal(existsSync(join(root, ".runtime")), false);
});
test("readLatest finds the most recent row matching the config's logical-key prefix only", () => {
  const root = temporary();
  const ledger = new RunLedger(root);
  try {
    ledger.record({logicalKey: "morning-plan:v1:abc123:2026-09-17", observedAt: "2026-09-17T00:00:00.000Z", status: "success", plan: validPlan});
    ledger.record({logicalKey: "morning-plan:v1:abc123:2026-09-18", observedAt: "2026-09-18T00:00:00.000Z", status: "failed", errorCode: "NOTION"});
    ledger.record({logicalKey: "morning-plan:v1:other-hash:2026-09-18", observedAt: "2026-09-18T00:00:00.000Z", status: "success", plan: validPlan});
  } finally { ledger.close(); }
  const latest = RunLedger.readLatest(root, "morning-plan:v1:abc123:");
  assert.equal(latest?.logicalKey, "morning-plan:v1:abc123:2026-09-18");
  assert.equal(latest?.status, "failed");
  assert.equal(latest?.errorCode, "NOTION");
  assert.equal(latest?.revision, 0);
});
test("readLatest refuses a symlinked ledger file", () => {
  const root = temporary();
  new RunLedger(root).close();
  const outside = temporary();
  const target = join(outside, "elsewhere.sqlite");
  new RunLedger(outside).close();
  renameSync(join(outside, ".runtime/runs.sqlite"), target);
  unlinkSync(join(root, ".runtime/runs.sqlite"));
  symlinkSync(target, join(root, ".runtime/runs.sqlite"));
  assert.throws(() => RunLedger.readLatest(root, "morning-plan:v1:abc123:"), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "STORAGE");
    return true;
  });
});
