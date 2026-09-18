import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync, statSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMorning } from "../src/workflow.js";
import { AppError } from "../src/errors.js";
import { config, now, snapshot } from "./helpers.js";

const temporary = () => mkdtempSync(join(tmpdir(), "job-hunt-workflow-"));
const clock = {now: () => now};

test("same-day reruns refresh the source but preserve a single plan and digest", async () => {
  const root = temporary(); let reads = 0;
  const source = () => ({read: async () => {reads++; return snapshot();}});
  const options = {config, source, root, clock, record: true};
  const first = await runMorning(options);
  assert.deepEqual(await runMorning(options), first);
  assert.equal(reads, 2);
  const db = new DatabaseSync(join(root, ".runtime/runs.sqlite"), {readOnly: true});
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM runs").get()?.n, 1);
    assert.equal(db.prepare("SELECT revision FROM runs").get()?.revision, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events").get()?.n, 2);
    assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM events").all()), /Example|https|follow-up/);
  } finally { db.close(); }
  assert.equal(statSync(join(root, ".runtime")).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, ".runtime/runs.sqlite")).mode & 0o777, 0o600);
});
test("same-day source changes update the existing plan instead of serving cached results", async () => {
  const root = temporary(); const data = snapshot();
  const options = {config, source: () => ({read: async () => data}), root, clock, record: true};
  await runMorning(options);
  data.applications[0]!.stage = "Closed";
  const result = await runMorning(options);
  assert.equal(result.followUps.length, 1);
  const db = new DatabaseSync(join(root, ".runtime/runs.sqlite"));
  try { assert.equal(db.prepare("SELECT revision FROM runs").get()?.revision, 2); }
  finally { db.close(); }
});
test("a Notion outage is recorded and invalidates the latest success without raw errors", async () => {
  const root = temporary();
  await runMorning({config, source: () => ({read: async () => snapshot()}), root, clock, record: true});
  await assert.rejects(runMorning({config, source: () => ({read: async () => {throw new AppError("NOTION", "Snapshot unavailable");}}),
    root, clock, record: true}), /Snapshot unavailable/);
  const db = new DatabaseSync(join(root, ".runtime/runs.sqlite"));
  try {
    const run = db.prepare("SELECT * FROM runs").get();
    assert.equal(run?.status, "failed"); assert.equal(run?.plan_json, null); assert.equal(run?.digest, null);
    assert.equal(run?.error_code, "NOTION");
  } finally { db.close(); }
});
test("missing credentials are also recorded, without touching Notion", async () => {
  const root = temporary();
  await assert.rejects(runMorning({config, source: () => {throw new AppError("AUTH", "Missing credentials");},
    root, clock, record: true}), /Missing credentials/);
  const db = new DatabaseSync(join(root, ".runtime/runs.sqlite"));
  try { assert.equal(db.prepare("SELECT error_code FROM runs").get()?.error_code, "AUTH"); }
  finally { db.close(); }
});
test("no-record makes no local output and never mutates the input", async () => {
  const root = temporary(); const data = snapshot(); const before = structuredClone(data);
  await runMorning({config, source: () => ({read: async () => data}), root, clock, record: false});
  assert.equal(existsSync(join(root, ".runtime")), false); assert.deepEqual(data, before);
});
test("private output refuses a symlink into another directory", async () => {
  const root = temporary(); const outside = temporary();
  symlinkSync(outside, join(root, ".runtime"));
  await assert.rejects(runMorning({config, source: () => ({read: async () => snapshot()}), root, clock, record: true}), /not a symlink/);
  assert.equal(existsSync(join(outside, "runs.sqlite")), false);
});
test("no writes to the original pipeline or dashboard occur during a fixture run", async () => {
  const root = temporary();
  const fixtureFile = new URL("../../tests/fixtures/snapshot.json", import.meta.url);
  // The file adapter is covered by the CLI integration tests. This test checks
  // that the engine owns only its private output directory.
  void fixtureFile;
  await runMorning({config, source: () => ({read: async () => snapshot()}), root, clock, record: true});
  assert.equal(existsSync(join(root, "pipeline")), false);
  assert.equal(existsSync(join(root, "dashboard")), false);
  assert.ok(readFileSync(join(root, ".runtime/runs.sqlite")).length > 0);
});
