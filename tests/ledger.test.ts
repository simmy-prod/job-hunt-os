import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RunLedger } from "../src/ledger.js";
import { AppError } from "../src/errors.js";
import type { RunRecord } from "../src/ledger.js";

const temporary = () => mkdtempSync(join(tmpdir(), "job-hunt-ledger-"));
const base = {logicalKey: "morning-plan:v1:abc123:2026-09-18", observedAt: "2026-09-18T00:00:00.000Z"};

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
    ledger.record({...base, status: "success", plan: {schemaVersion: 1, mode: "read_only", date: "2026-09-18",
      timezone: "Australia/Melbourne", dueTargets: [], followUps: [], reviews: [],
      counts: {targets: 0, applications: 0, dueTargets: 0, followUps: 0, reviews: 0}}});
    assert.deepEqual(tableCounts(root), {runs: 1, events: 1});
  } finally { ledger.close(); }
});
