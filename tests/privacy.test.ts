import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPublicSample, checkRuntimeSource, checkWriteIsolation } from "../scripts/check-boundaries.mjs";
import { buildPublic } from "../scripts/build-public.mjs";
import { root } from "./helpers.js";

function fixtureRoot() {
  const directory = mkdtempSync(join(tmpdir(), "job-hunt-public-"));
  mkdirSync(join(directory, "dashboard"));
  for (const file of ["index.html", "data.json", "sample-manifest.json"]) {
    copyFileSync(join(root, "dashboard", file), join(directory, "dashboard", file));
  }
  return directory;
}
test("public build allowlist excludes local JSON and other private artifacts", () => {
  const directory = fixtureRoot();
  writeFileSync(join(directory, "dashboard/data.local.json"), '{"company":"PRIVATE_SENTINEL"}');
  writeFileSync(join(directory, "dashboard/private-notes.md"), "PRIVATE_SENTINEL");
  const output = buildPublic(directory);
  assert.deepEqual(readdirSync(output).sort(), ["data.json", "index.html"]);
  assert.doesNotMatch(readFileSync(join(output, "data.json"), "utf8"), /PRIVATE_SENTINEL/);
});
test("copying a real-looking dataset into the public sample fails closed", () => {
  const directory = fixtureRoot();
  writeFileSync(join(directory, "dashboard/data.json"), '{"applications":[{"company":"PRIVATE_SENTINEL"}]}');
  assert.throws(() => checkPublicSample(directory), /Public sample changed/);
  assert.throws(() => buildPublic(directory), /Public sample changed/);
});
test("preexisting unexpected public files are rejected rather than deployed", () => {
  const directory = fixtureRoot(); buildPublic(directory);
  writeFileSync(join(directory, ".public/data.local.json"), "private");
  assert.throws(() => buildPublic(directory), /unexpected files/);
});
for (const source of [
  'import Anthropic from "@anthropic-ai/sdk";', 'import OpenAI from "openai";',
  'import { exec } from "node:child_process";', 'import "@modelcontextprotocol/sdk";',
  'await import("openai");', 'eval("x")', 'new Function("return 1")',
  'client.pages.create({parent: {}, properties: {}});', 'client.comments.create({});', 'this.client.blocks.delete({});',
  'client.dataSources.update({});', 'client.databases.update({});', 'client.pages.move({});',
]) test(`runtime boundary rejects ${source}`, () => {
  assert.ok(checkRuntimeSource(source, "src/example.ts").length > 0);
});
test("only the credentials module may start a subprocess, and only the Keychain lookup", () => {
  const keychain = 'import { execFileSync } from "node:child_process"; execFileSync("/usr/bin/security", ["find-generic-password"]);';
  assert.deepEqual(checkRuntimeSource(readFileSync(join(root, "src/credentials.ts"), "utf8"), "src/credentials.ts"), []);
  assert.deepEqual(checkRuntimeSource(keychain, "src/credentials.ts"), []);
  for (const [source, filename] of [
    [keychain, "src/scheduler.ts"],
    ['import { execFileSync } from "node:child_process"; execFileSync("/bin/sh", ["-c", "claude"]);', "src/credentials.ts"],
    ['import { execFileSync } from "node:child_process"; const run = execFileSync; run("/usr/local/bin/codex");', "src/credentials.ts"],
    ['import { execFileSync as run } from "node:child_process"; run("/usr/bin/security");', "src/credentials.ts"],
    ['import { spawn } from "node:child_process";', "src/credentials.ts"],
    ['import * as child from "node:child_process";', "src/credentials.ts"],
  ]) assert.ok(checkRuntimeSource(source!, filename!).length > 0, source);
});
test("runtime boundary accepts the approved direct Notion SDK and allowlisted operations", () => {
  assert.deepEqual(checkRuntimeSource('import { Client } from "@notionhq/client";', "src/notion.ts"), []);
  assert.deepEqual(checkRuntimeSource('client.pages.update({}); client.pages.retrieve({}); client.dataSources.retrieve({});', "src/notion-writer.ts"), []);
});

test("the unattended scheduler cannot reach a write module, directly or indirectly", () => {
  const clean = new Map([["src/scheduler.ts", 'import { runMorning } from "./workflow.js";'], ["src/workflow.ts", 'import { hash } from "./planner.js";']]);
  assert.deepEqual(checkWriteIsolation(clean), []);
  const direct = new Map([["src/scheduler.ts", 'import { applyWrites } from "./write-workflow.js";']]);
  assert.match(checkWriteIsolation(direct).join(), /write-workflow/);
  const indirect = new Map([["src/scheduler.ts", 'import { x } from "./workflow.js";'], ["src/workflow.ts", 'export { Outbox } from "./outbox.js";']]);
  assert.match(checkWriteIsolation(indirect).join(), /outbox\.ts through src\/workflow\.ts/);
});
