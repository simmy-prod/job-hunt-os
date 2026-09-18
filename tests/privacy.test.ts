import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPublicSample, checkRuntimeSource } from "../scripts/check-boundaries.mjs";
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
]) test(`runtime boundary rejects ${source}`, () => {
  assert.ok(checkRuntimeSource(source, "src/example.ts").length > 0);
});
test("runtime boundary accepts the approved direct Notion SDK", () => {
  assert.deepEqual(checkRuntimeSource('import { Client } from "@notionhq/client";', "src/notion.ts"), []);
});
