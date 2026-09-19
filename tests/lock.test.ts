import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lock.js";
import { AppError } from "../src/errors.js";

const temporary = () => mkdtempSync(join(tmpdir(), "job-hunt-lock-"));

test("acquiring and releasing a lock leaves no trace behind", () => {
  const root = temporary();
  const lock = acquireLock(root);
  assert.ok(existsSync(join(root, ".runtime/morning.lock")));
  lock.release();
  assert.equal(existsSync(join(root, ".runtime/morning.lock")), false);
});
test("a second acquisition while the first is held fails with LOCKED", () => {
  const root = temporary();
  const first = acquireLock(root);
  try {
    assert.throws(() => acquireLock(root), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "LOCKED");
      return true;
    });
  } finally { first.release(); }
});
test("a stale lock (dead pid) is recovered without deleting unrelated files", () => {
  const root = temporary();
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const pid = dead.pid;
  assert.ok(pid && pid > 0);
  // Acquire once to create .runtime with the correct mode, then release and
  // hand-write a lock referencing the now-dead pid in its place.
  acquireLock(root).release();
  writeFileSync(join(root, ".runtime/sentinel.txt"), "keep-me");
  writeFileSync(join(root, ".runtime/morning.lock"), JSON.stringify({pid, startedAt: Date.now(), token: "stale-token"}));
  const recovered = acquireLock(root);
  try {
    const written = JSON.parse(readFileSync(join(root, ".runtime/morning.lock"), "utf8"));
    assert.notEqual(written.token, "stale-token");
    assert.ok(existsSync(join(root, ".runtime/sentinel.txt")));
  } finally { recovered.release(); }
});
test("a lock older than the staleness window is recovered even if its pid happens to be alive", () => {
  const root = temporary();
  acquireLock(root).release();
  const sixHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
  writeFileSync(join(root, ".runtime/morning.lock"), JSON.stringify({pid: process.pid, startedAt: sixHoursAgo, token: "ancient"}));
  const recovered = acquireLock(root);
  recovered.release();
});
test("release only removes a lock this call actually wrote", () => {
  const root = temporary();
  const ours = acquireLock(root);
  // Simulate the lock having been recovered and re-acquired by someone else
  // between our acquisition and our release.
  writeFileSync(join(root, ".runtime/morning.lock"), JSON.stringify({pid: process.pid, startedAt: Date.now(), token: "someone-elses-token"}));
  ours.release();
  assert.ok(existsSync(join(root, ".runtime/morning.lock")));
});
test("refuses a symlinked .runtime directory", () => {
  const root = temporary();
  const outside = temporary();
  symlinkSync(outside, join(root, ".runtime"));
  assert.throws(() => acquireLock(root), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "STORAGE");
    return true;
  });
});
