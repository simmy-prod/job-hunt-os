import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGitignore, checkNodeVersion, checkRuntimeDir, runDoctorReport } from "../src/doctor.js";
import { AppError } from "../src/errors.js";
import { FileSnapshotSource } from "../src/source.js";
import { config, now, snapshot, root as repoRoot } from "./helpers.js";

const temporary = () => mkdtempSync(join(tmpdir(), "job-hunt-doctor-"));
function writeGitignore(root: string, lines: string[]) {
  writeFileSync(join(root, ".gitignore"), lines.join("\n"));
}
function writePackageJson(root: string, engineNode: string) {
  writeFileSync(join(root, "package.json"), JSON.stringify({engines: {node: engineNode}}));
}

test("node version check passes the current interpreter against the real package.json contract", () => {
  const result = checkNodeVersion(repoRoot);
  assert.equal(result.ok, true);
  assert.equal(result.current, process.versions.node);
});
test("node version check fails closed when the requirement is not met", () => {
  const root = temporary();
  writePackageJson(root, ">=9999.0.0");
  assert.equal(checkNodeVersion(root).ok, false);
});
test("node version check fails safely (not throwing) when package.json is missing", () => {
  const root = temporary();
  const result = checkNodeVersion(root);
  assert.equal(result.ok, false);
  assert.equal(result.required, null);
});
test("runtime directory check accepts an absent directory when the root is writable", () => {
  const root = temporary();
  assert.equal(checkRuntimeDir(root).ok, true);
});
test("runtime directory check rejects a symlinked .runtime", () => {
  const root = temporary();
  const outside = temporary();
  symlinkSync(outside, join(root, ".runtime"));
  const result = checkRuntimeDir(root);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "symlink");
});
test("runtime directory check rejects unexpected permissions on an existing directory", () => {
  const root = temporary();
  mkdirSync(join(root, ".runtime"), {mode: 0o755});
  chmodSync(join(root, ".runtime"), 0o755);
  const result = checkRuntimeDir(root);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unexpected_permissions");
});
test("gitignore check passes the repository's real .gitignore", () => {
  assert.equal(checkGitignore(repoRoot).ok, true);
});
test("gitignore check names every missing private-path entry", () => {
  const root = temporary();
  writeGitignore(root, ["node_modules/"]);
  const result = checkGitignore(root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["profile/", "pipeline/", "prep/", "targets/", ".runtime/", ".env"]);
});
test("gitignore check fails closed when .gitignore is missing entirely", () => {
  const root = temporary();
  assert.equal(checkGitignore(root).ok, false);
});
test("a full report aggregates independent checks and still runs the rest when configuration fails", async () => {
  const root = temporary();
  const report = await runDoctorReport({
    root, now,
    resolveConfig: () => { throw new AppError("CONFIG", "bad config for this test"); },
    buildSource: () => new FileSnapshotSource("/dev/null"),
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.config.ok, false);
  assert.match(report.checks.config.message ?? "", /bad config for this test/);
  assert.equal(report.checks.source.skipped, true);
  assert.equal(report.counts, null);
  // Independent checks still ran and were not short-circuited by the config failure.
  assert.equal(typeof report.checks.node.ok, "boolean");
  assert.equal(typeof report.checks.gitignore.ok, "boolean");
});
test("a full report surfaces a source/schema failure without hiding the other checks", async () => {
  const root = temporary();
  const report = await runDoctorReport({
    root, now,
    resolveConfig: () => Promise.resolve(config),
    buildSource: () => ({read: () => { throw new AppError("NOTION", "unreachable for this test"); }}),
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.config.ok, true);
  assert.equal(report.checks.source.ok, false);
  assert.equal(report.worstCode, "NOTION");
});
test("a healthy demo-shaped configuration reports ok with counts and no warning", async () => {
  const root = temporary();
  const demoConfig = {...config, source: {driver: "snapshot" as const, path: `${repoRoot}/tests/fixtures/snapshot.json`}};
  const report = await runDoctorReport({
    root, now,
    resolveConfig: () => Promise.resolve(demoConfig),
    buildSource: (c) => c.source.driver === "snapshot" ? new FileSnapshotSource(c.source.path) : new FileSnapshotSource("/dev/null"),
  });
  assert.equal(report.checks.source.ok, true);
  assert.equal(report.counts?.targets, snapshot().targets.length);
  assert.equal(report.warning, null);
});
