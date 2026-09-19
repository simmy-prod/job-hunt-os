import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, snapshot } from "./helpers.js";

function cli(args: string[], cwd = root, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(root, "dist/src/cli.js"), ...args], {
    cwd, encoding: "utf8", timeout: 15_000,
    env: {PATH: "/usr/bin:/bin", TZ: "Pacific/Honolulu", ...env},
  });
}
function scheduleConfig(schedule?: {enabled: boolean; time: string}) {
  const directory = mkdtempSync(join(tmpdir(), "job-hunt-schedule-cli-"));
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify({schemaVersion: 1, timezone: "Australia/Melbourne",
    source: {driver: "snapshot", path: "snapshot.json"}, ...(schedule ? {schedule} : {})}));
  writeFileSync(join(directory, "snapshot.json"), JSON.stringify(snapshot()));
  return {directory, path, home: mkdtempSync(join(tmpdir(), "job-hunt-schedule-home-"))};
}
test("demo CLI runs independently of coding agents, credentials, cwd and system timezone", () => {
  const args = ["plan", "--demo", "--json", "--no-record", "--at", "2026-09-18T00:00:00Z"];
  const result = cli(args, tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).date, "2026-09-18");
  assert.equal(JSON.parse(result.stdout).counts.dueTargets, 2);
  assert.equal(cli(args).stdout, result.stdout);
});
test("doctor validates a fictional source without requiring a token", () => {
  const result = cli(["doctor", "--demo", "--json"]);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, "ok");
});
test("snapshot paths resolve relative to config, and malformed input produces a nonzero exit", () => {
  const directory = mkdtempSync(join(tmpdir(), "job-hunt-cli-"));
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify({schemaVersion: 1, timezone: "Australia/Melbourne", source: {driver: "snapshot", path: "snapshot.json"}}));
  writeFileSync(join(directory, "snapshot.json"), JSON.stringify(snapshot()));
  const args = ["plan", "--config", path, "--json", "--no-record"];
  assert.equal(cli(args).status, 0);
  writeFileSync(join(directory, "snapshot.json"), "{malformed-private-input");
  const failed = cli(args);
  assert.equal(failed.status, 2); assert.equal(failed.stdout, ""); assert.doesNotMatch(failed.stderr, /malformed-private-input/);
});
test("missing standalone token fails with an actionable message and no fallback", () => {
  const result = cli(["plan", "--config", "templates/runtime-config.json", "--no-record"]);
  assert.equal(result.status, 2); assert.match(result.stderr, /NOTION_TOKEN/); assert.equal(result.stdout, "");
});
for (const args of [["plan", "--apply"], ["plan", "--demo", "--config", "x"],
  ["plan", "--demo", "--at", "yesterday"], ["plan", "--demo", "--at", "2026-09-18T00:00:00"], ["scan"]]) {
  test(`CLI rejects unsupported or ambiguous arguments: ${args.join(" ")}`, () => {
    assert.equal(cli(args).status, 2);
  });
}

// Scheduler CLI paths that never write: the ledger-writing path is covered in scheduler.test.ts
// with temporary roots, so these tests never touch a real ledger or load a real LaunchAgent.
test("schedule run is silent and inert when scheduling is disabled or absent", () => {
  for (const schedule of [undefined, {enabled: false, time: "08:00"}]) {
    const {path} = scheduleConfig(schedule);
    const result = cli(["schedule", "run", "--config", path]);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(cli(["schedule", "run", "--config", path, "--json"]).stdout).outcome, "disabled");
  }
});
test("schedule run before the configured Melbourne time exits without work, whatever the system timezone", () => {
  const {path} = scheduleConfig({enabled: true, time: "08:00"});
  const result = cli(["schedule", "run", "--config", path, "--json", "--at", "2026-09-18T21:59:00Z"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {outcome: "not_due", date: "2026-09-19"});
});
test("schedule preview prints a credential-free plist and writes nothing", () => {
  const {path, home} = scheduleConfig({enabled: true, time: "07:45"});
  const result = cli(["schedule", "preview", "--config", path], root, {HOME: home});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /<string>local\.job-hunt-os\.morning-plan<\/string>/);
  assert.match(result.stdout, new RegExp(`<string>${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
  assert.match(result.stdout, /<integer>7<\/integer>\s*<key>Minute<\/key>\s*<integer>45<\/integer>/);
  assert.doesNotMatch(result.stdout, /NOTION_TOKEN|ntn_/);
  assert.deepEqual(readdirSync(home), []);
  const disabled = cli(["schedule", "preview", "--config", scheduleConfig({enabled: false, time: "08:00"}).path]);
  assert.equal(disabled.status, 2); assert.match(disabled.stderr, /schedule\.enabled/);
});
test("schedule status is read-only and reports no plan contents", () => {
  const {path, home} = scheduleConfig({enabled: true, time: "08:00"});
  const result = cli(["schedule", "status", "--config", path, "--json", "--at", "2026-09-18T22:00:00Z"], root, {HOME: home});
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.enabled, true); assert.equal(status.installed, false); assert.equal(status.date, "2026-09-19");
  assert.equal(status.today, "never_run");
  assert.doesNotMatch(result.stdout, /Example|https?:/);
  assert.deepEqual(readdirSync(home), []);
});
test("schedule uninstall with nothing installed changes nothing", () => {
  const {home} = scheduleConfig();
  const result = cli(["schedule", "uninstall"], root, {HOME: home});
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Nothing changed/);
  assert.deepEqual(readdirSync(home), []);
});
for (const args of [["schedule"], ["schedule", "start"], ["schedule", "run", "--demo"], ["schedule", "install", "--json"],
  ["schedule", "preview", "--no-record"], ["schedule", "uninstall", "--config", "x"], ["schedule", "run", "extra", "arg"]]) {
  test(`schedule rejects unsupported or ambiguous arguments: ${args.join(" ")}`, () => {
    assert.equal(cli(args).status, 2);
  });
}
