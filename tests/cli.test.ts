import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, snapshot } from "./helpers.js";

function cli(args: string[], cwd = root) {
  return spawnSync(process.execPath, [join(root, "dist/src/cli.js"), ...args], {
    cwd, encoding: "utf8", timeout: 15_000,
    env: {PATH: "/usr/bin:/bin", TZ: "Pacific/Honolulu"},
  });
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
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.source.ok, true);
  assert.equal(report.checks.node.ok, true);
});
test("dry-run marks output and never creates the ledger, even alongside --no-record", () => {
  const args = ["plan", "--demo", "--json", "--dry-run", "--no-record", "--at", "2026-09-18T00:00:00Z"];
  const cwd = mkdtempSync(join(tmpdir(), "job-hunt-dry-run-"));
  const result = cli(args, cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).dryRun, true);
  assert.equal(existsSync(join(cwd, ".runtime")), false);
});
test("dry-run text output announces itself and the ledger stays untouched", () => {
  const cwd = mkdtempSync(join(tmpdir(), "job-hunt-dry-run-text-"));
  const result = cli(["plan", "--demo", "--dry-run", "--at", "2026-09-18T00:00:00Z"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run: nothing written to the ledger/);
  assert.equal(existsSync(join(cwd, ".runtime")), false);
});
for (const command of ["doctor", "status"]) {
  for (const flag of ["--dry-run", "--no-record"]) {
    test(`${command} rejects ${flag}, which would otherwise be silently ignored`, () => {
      const result = cli([command, "--demo", flag]);
      assert.equal(result.status, 2);
    });
  }
}
test("status distinguishes never-run, success, stale, and failed states", () => {
  const directory = mkdtempSync(join(tmpdir(), "job-hunt-status-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({schemaVersion: 1, timezone: "Australia/Melbourne", source: {driver: "snapshot", path: "snapshot.json"}}));
  writeFileSync(join(directory, "snapshot.json"), JSON.stringify(snapshot()));
  const statusArgs = ["status", "--config", configPath, "--json"];
  const day1 = "2026-09-18T09:00:00+10:00";
  const day2 = "2026-09-19T09:00:00+10:00";

  const neverRun = cli([...statusArgs, "--at", day1], directory);
  assert.equal(neverRun.status, 0, neverRun.stderr);
  assert.equal(JSON.parse(neverRun.stdout).state, "never_run");

  assert.equal(cli(["plan", "--config", configPath, "--json", "--at", day1], directory).status, 0);
  const success = cli([...statusArgs, "--at", day1], directory);
  const successBody = JSON.parse(success.stdout);
  assert.equal(successBody.state, "success");
  assert.equal(successBody.latestRunDate, "2026-09-18");
  assert.equal(successBody.errorCode, null);

  const stale = cli([...statusArgs, "--at", day2], directory);
  assert.equal(JSON.parse(stale.stdout).state, "stale");

  writeFileSync(join(directory, "snapshot.json"), "{malformed");
  assert.equal(cli(["plan", "--config", configPath, "--json", "--at", day2], directory).status, 2);
  const failed = cli([...statusArgs, "--at", day2], directory);
  const failedBody = JSON.parse(failed.stdout);
  assert.equal(failedBody.state, "failed");
  assert.equal(failedBody.errorCode, "CONFIG");
});
test("status text mode reports plainly and never touches the ledger", () => {
  const cwd = mkdtempSync(join(tmpdir(), "job-hunt-status-text-"));
  const result = cli(["status", "--demo", "--at", "2026-09-18T00:00:00Z"], cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status: never_run/);
  assert.equal(existsSync(join(cwd, ".runtime")), false);
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
