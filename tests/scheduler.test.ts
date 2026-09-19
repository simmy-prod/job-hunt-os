import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { acquireLock } from "../src/lock.js";
import { createNotionReader, NotionSnapshotSource } from "../src/notion.js";
import { installLaunchAgent, LAUNCH_AGENT_LABEL, launchAgentPath, localTime, MAX_SCHEDULED_FAILURES, renderLaunchAgent,
  runScheduled, scheduleStatus, uninstallLaunchAgent, validateLaunchAgentPaths } from "../src/scheduler.js";
import { hash } from "../src/planner.js";
import { logicalKey, logicalKeyPrefix, runMorning } from "../src/workflow.js";
import { batch, config, metadata, notionConfig, page, snapshot } from "./helpers.js";

const temporary = (prefix = "job-hunt-scheduler-") => mkdtempSync(join(tmpdir(), prefix));
const scheduled: Config = {...config, schedule: {enabled: true, time: "08:00"}};
// 2026-09-19 08:00 in Melbourne (AEST, +10).
const due = new Date("2026-09-18T22:00:00Z");
const at = (date: Date) => ({now: () => date});
function counter() {
  const state = {reads: 0};
  return {state, source: () => ({read: async () => { state.reads++; return snapshot(); }})};
}
function query<T>(root: string, sql: string): T[] {
  const db = new DatabaseSync(join(root, ".runtime/runs.sqlite"), {readOnly: true});
  // SQLite rows have a null prototype; copy them into plain objects for deepEqual.
  try { return db.prepare(sql).all().map((row) => ({...row}) as T); } finally { db.close(); }
}
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid);
  return child.pid;
}
// Leaves a Slice 2.1 lock file behind, as a crashed or still-running process would.
function leaveLock(root: string, pid: number, startedAt = Date.now()): void {
  acquireLock(root).release();
  writeFileSync(join(root, ".runtime/morning.lock"), JSON.stringify({pid, startedAt, token: "left-behind"}));
}

// Duplicate execution
test("a second trigger on the same business day does not contact the source again", async () => {
  const root = temporary(); const {state, source} = counter();
  const first = await runScheduled({config: scheduled, source, root, clock: at(due)});
  const second = await runScheduled({config: scheduled, source, root, clock: at(new Date(due.getTime() + 3_600_000))});
  assert.equal(first.outcome, "success"); assert.equal(first.date, "2026-09-19");
  assert.equal(second.outcome, "already_succeeded");
  assert.equal(state.reads, 1);
  assert.deepEqual(query(root, "SELECT outcome, invoker FROM events"), [{outcome: "success", invoker: "scheduled"}]);
  assert.deepEqual(query(root, "SELECT count(*) AS n FROM runs"), [{n: 1}]);
  assert.equal(existsSync(join(root, ".runtime/morning.lock")), false);
});
test("simultaneous triggers produce one active workflow and one logical result", async () => {
  const root = temporary(); let reads = 0; let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const source = () => ({read: async () => { reads++; await gate; return snapshot(); }});
  const first = runScheduled({config: scheduled, source, root, clock: at(due)});
  const second = await runScheduled({config: scheduled, source, root, clock: at(due)});
  assert.equal(second.outcome, "busy");
  open();
  assert.equal((await first).outcome, "success");
  assert.equal(reads, 1);
  assert.deepEqual(query(root, "SELECT count(*) AS n FROM events"), [{n: 1}]);
});
test("a manual recorded run cannot race an active scheduled run", async () => {
  const root = temporary(); let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const scheduledRun = runScheduled({config: scheduled, root, clock: at(due),
    source: () => ({read: async () => { await gate; return snapshot(); }})});
  await assert.rejects(runMorning({config: scheduled, source: counter().source, root, clock: at(due), record: true}),
    (error: AppError) => error.code === "LOCKED" && /holds the lock/.test(error.message));
  open(); await scheduledRun;
  // Lock-free reads that record nothing still work alongside.
  await runMorning({config: scheduled, source: counter().source, root, clock: at(due), record: false});
});
test("a manual success satisfies the day for the scheduler, and manual runs always refresh", async () => {
  const root = temporary(); const {state, source} = counter();
  await runMorning({config: scheduled, source, root, clock: at(due), record: true});
  assert.equal((await runScheduled({config: scheduled, source, root, clock: at(due)})).outcome, "already_succeeded");
  await runMorning({config: scheduled, source, root, clock: at(due), record: true});
  assert.equal(state.reads, 2);
});
test("editing the schedule never forks the logical run key", () => {
  const changed: Config = {...config, schedule: {enabled: false, time: "17:30"}};
  const {schedule: _schedule, ...unscheduled} = scheduled;
  assert.ok(_schedule);
  assert.equal(logicalKey(scheduled, due), logicalKey(changed, due));
  assert.equal(logicalKey(scheduled, due), logicalKey(unscheduled, due));
  // Existing configs (no schedule block) keep the exact pre-scheduler key, so history survives.
  assert.equal(logicalKeyPrefix(unscheduled), `morning-plan:v1:${hash(unscheduled)}:`);
});

// Restart and recovery (the lock is the Slice 2.1 file lock, shared with manual runs)
test("a lock left by a crashed or rebooted process is recovered", async () => {
  const root = temporary(); leaveLock(root, deadPid());
  const {state, source} = counter();
  assert.equal((await runScheduled({config: scheduled, source, root, clock: at(due)})).outcome, "success");
  assert.equal(state.reads, 1);
  assert.equal(existsSync(join(root, ".runtime/morning.lock")), false);
});
test("a lock held by a live process is respected until it exceeds the age limit", async () => {
  const fresh = temporary(); leaveLock(fresh, process.pid);
  assert.equal((await runScheduled({config: scheduled, source: counter().source, root: fresh, clock: at(due)})).outcome, "busy");
  const aged = temporary(); leaveLock(aged, process.pid, Date.now() - 7 * 60 * 60 * 1000);
  assert.equal((await runScheduled({config: scheduled, source: counter().source, root: aged, clock: at(due)})).outcome, "success");
});
test("a run interrupted before recording leaves no success, so the next trigger reruns it", async () => {
  const root = temporary(); leaveLock(root, deadPid());
  const status = scheduleStatus({config: scheduled, root, now: due, plistPath: join(root, "none.plist"), expectedPlist: null, systemTimezone: "Australia/Melbourne"});
  assert.equal(status.today, "never_run"); assert.equal(status.lock, "stale");
  const {state, source} = counter();
  assert.equal((await runScheduled({config: scheduled, source, root, clock: at(due)})).outcome, "success");
  assert.equal(state.reads, 1);
});
test("a ledger from before scheduling is migrated in place without losing history", async () => {
  const root = temporary(); mkdirSync(join(root, ".runtime"), {mode: 0o700});
  const db = new DatabaseSync(join(root, ".runtime/runs.sqlite"));
  db.exec(`CREATE TABLE runs (logical_key TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
      observed_at TEXT NOT NULL, revision INTEGER NOT NULL, plan_hash TEXT, plan_json TEXT, digest TEXT, error_code TEXT) STRICT;
    CREATE TABLE events (id INTEGER PRIMARY KEY, logical_key TEXT NOT NULL, observed_at TEXT NOT NULL, outcome TEXT NOT NULL, error_code TEXT) STRICT;
    INSERT INTO events (logical_key, observed_at, outcome, error_code) VALUES ('old', '2026-09-01T00:00:00.000Z', 'failed', 'NOTION');
    PRAGMA user_version = 1;`);
  db.close();
  assert.equal((await runScheduled({config: scheduled, source: counter().source, root, clock: at(due)})).outcome, "success");
  assert.deepEqual(query(root, "SELECT logical_key, invoker FROM events ORDER BY id").map((row) => (row as {invoker: string}).invoker), ["manual", "scheduled"]);
  assert.deepEqual(query(root, "PRAGMA user_version"), [{user_version: 2}]);
});

// Timezone boundaries
test("the configured time is enforced in the business timezone, not the system timezone", async () => {
  const root = temporary(); const {state, source} = counter();
  const early = new Date("2026-09-18T21:59:00Z"); // 07:59 in Melbourne, 21:59 in UTC
  assert.equal(localTime(early, "Australia/Melbourne"), "07:59");
  assert.equal((await runScheduled({config: scheduled, source, root, clock: at(early)})).outcome, "not_due");
  assert.equal(existsSync(join(root, ".runtime")), false);
  assert.equal(state.reads, 0);
  assert.equal((await runScheduled({config: scheduled, source, root, clock: at(due)})).outcome, "success");
});
test("Melbourne midnight starts a new logical day", async () => {
  const root = temporary(); const {state, source} = counter();
  const lateNight = {...scheduled, schedule: {enabled: true, time: "00:00"}};
  const beforeMidnight = await runScheduled({config: lateNight, source, root, clock: at(new Date("2026-09-18T13:59:59Z"))});
  const afterMidnight = await runScheduled({config: lateNight, source, root, clock: at(new Date("2026-09-18T14:00:00Z"))});
  assert.equal(beforeMidnight.date, "2026-09-18"); assert.equal(afterMidnight.date, "2026-09-19");
  assert.equal(afterMidnight.outcome, "success"); assert.equal(state.reads, 2);
  assert.deepEqual(query(root, "SELECT count(*) AS n FROM runs"), [{n: 2}]);
});
test("a skipped DST hour cannot skip the day, and a repeated hour cannot run it twice", async () => {
  const root = temporary(); const {state, source} = counter();
  const skipped = {...scheduled, schedule: {enabled: true, time: "02:30"}};
  // 2026-10-04: Melbourne clocks jump from 02:00 AEST to 03:00 AEDT, so 02:30 never happens.
  assert.equal((await runScheduled({config: skipped, source, root, clock: at(new Date("2026-10-03T15:59:00Z"))})).outcome, "not_due");
  const jumped = await runScheduled({config: skipped, source, root, clock: at(new Date("2026-10-03T16:00:00Z"))});
  assert.equal(localTime(new Date("2026-10-03T16:00:00Z"), "Australia/Melbourne"), "03:00");
  assert.equal(jumped.outcome, "success"); assert.equal(jumped.date, "2026-10-04");
  // 2027-04-04: 03:00 AEDT falls back to 02:00 AEST, so 02:30 happens twice.
  const firstPass = await runScheduled({config: skipped, source, root, clock: at(new Date("2027-04-03T15:30:00Z"))});
  const secondPass = await runScheduled({config: skipped, source, root, clock: at(new Date("2027-04-03T16:30:00Z"))});
  assert.equal(firstPass.date, "2027-04-04"); assert.equal(secondPass.date, "2027-04-04");
  assert.equal(firstPass.outcome, "success"); assert.equal(secondPass.outcome, "already_succeeded");
  assert.equal(state.reads, 2);
});

// Failed runs
test("failures are recorded, retried by later triggers, and capped per day", async () => {
  const root = temporary(); let reads = 0;
  const failing = () => ({read: async () => { reads++; throw new AppError("NOTION", "Snapshot unavailable"); }});
  for (let attempt = 1; attempt <= MAX_SCHEDULED_FAILURES; attempt++) {
    const result = await runScheduled({config: scheduled, source: failing, root, clock: at(due)});
    assert.equal(result.outcome, "failed"); assert.equal(result.errorCode, "NOTION");
  }
  assert.equal((await runScheduled({config: scheduled, source: failing, root, clock: at(due)})).outcome, "attempts_exhausted");
  assert.equal(reads, MAX_SCHEDULED_FAILURES);
  const status = scheduleStatus({config: scheduled, root, now: due, plistPath: join(root, "none.plist"), expectedPlist: null, systemTimezone: "UTC"});
  assert.equal(status.today, "attempts_exhausted"); assert.equal(status.errorCode, "NOTION");
  assert.match(status.timezoneWarning ?? "", /hourly re-check/);
  // A manual run is never capped, and its success clears the day.
  await runMorning({config: scheduled, source: counter().source, root, clock: at(due), record: true});
  assert.equal(scheduleStatus({config: scheduled, root, now: due, plistPath: join(root, "none.plist"), expectedPlist: null, systemTimezone: "UTC"}).today, "success");
});
test("a failure followed by a successful retry leaves only the success visible", async () => {
  const root = temporary(); let fail = true;
  const flaky = () => ({read: async () => { if (fail) throw new AppError("NOTION", "Snapshot unavailable"); return snapshot(); }});
  assert.equal((await runScheduled({config: scheduled, source: flaky, root, clock: at(due)})).outcome, "failed");
  fail = false;
  assert.equal((await runScheduled({config: scheduled, source: flaky, root, clock: at(due)})).outcome, "success");
  const [run] = query<{status: string; error_code: string | null}>(root, "SELECT status, error_code FROM runs");
  assert.equal(run?.status, "success"); assert.equal(run?.error_code, null);
});
test("raw errors and credentials never reach the ledger or the result", async () => {
  const root = temporary(); const secret = "ntn_" + "S".repeat(40);
  const leaking = () => ({read: async () => { throw new Error(`${secret} private-person@example.org`); }});
  const result = await runScheduled({config: scheduled, source: leaking, root, clock: at(due)});
  assert.equal(result.outcome, "failed"); assert.equal(result.errorCode, "INPUT");
  assert.doesNotMatch(JSON.stringify(result), /ntn_|private-person/);
  assert.doesNotMatch(readFileSync(join(root, ".runtime/runs.sqlite")).toString("latin1"), /ntn_|private-person/);
});
test("a missing credential is a recorded AUTH failure that never reaches Notion", async () => {
  const root = temporary();
  const result = await runScheduled({config: scheduled, root, clock: at(due),
    source: () => { throw new AppError("AUTH", "Cannot read the Notion token from the macOS login Keychain."); }});
  assert.equal(result.errorCode, "AUTH");
  assert.deepEqual(query(root, "SELECT outcome, error_code, invoker FROM events"), [{outcome: "failed", error_code: "AUTH", invoker: "scheduled"}]);
});
test("scheduled runs use only the two read-only Notion operations and never persist the token", async () => {
  const root = temporary(); const token = "ntn_" + "T".repeat(40);
  const calls: Array<[string, string | undefined]> = [];
  const source = () => new NotionSnapshotSource(notionConfig, createNotionReader(notionConfig, token, async (url, init) => {
    calls.push([new URL(url).pathname, init.method]);
    return Response.json(init.method === "GET" ? metadata() : batch([page()]));
  }));
  assert.equal((await runScheduled({config: scheduled, source, root, clock: at(due)})).outcome, "success");
  const base = `/v1/data_sources/${notionConfig.dataSourceId}`;
  assert.deepEqual(calls, [[base, "GET"], [`${base}/query`, "POST"]]);
  assert.doesNotMatch(readFileSync(join(root, ".runtime/runs.sqlite")).toString("latin1"), /ntn_/);
});

// Disabled scheduling
for (const [label, disabled] of [["absent", config], ["false", {...config, schedule: {enabled: false, time: "08:00"}}]] as const) {
  test(`scheduling ${label} is inert: no ledger, no credentials, no source read`, async () => {
    const root = temporary(); let touched = 0;
    const result = await runScheduled({config: disabled, root, clock: at(due), source: () => { touched++; throw new Error("unreachable"); }});
    assert.equal(result.outcome, "disabled"); assert.equal(touched, 0);
    assert.equal(existsSync(join(root, ".runtime")), false);
    assert.throws(() => renderLaunchAgent({node: "/n", cli: "/c", config: "/f", root: "/r"}, disabled), /schedule.enabled/);
  });
}

// LaunchAgent artifacts (temporary directories only; nothing is loaded into launchd)
function installable() {
  const root = temporary("job-hunt-root-"); const home = temporary("job-hunt-home-");
  const configPath = join(root, "runtime.json"); writeFileSync(configPath, "{}");
  const cli = join(root, "cli.js"); writeFileSync(cli, "");
  return {root, home, paths: {node: process.execPath, cli, config: configPath, root}};
}
test("the LaunchAgent carries absolute paths, recovery triggers, and no credential", () => {
  const {paths} = installable();
  const plist = renderLaunchAgent(validateLaunchAgentPaths(paths), scheduled);
  assert.match(plist, new RegExp(`<string>${LAUNCH_AGENT_LABEL}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>Hour<\/key>\s*<integer>8<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  assert.match(plist, /<string>schedule<\/string>\s*<string>run<\/string>\s*<string>--config<\/string>/);
  assert.doesNotMatch(plist, /NOTION_TOKEN|ntn_|secret_|\/bin\/sh|claude|codex/i);
  const programArguments = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  assert.equal(programArguments[1], process.execPath);
  assert.match(renderLaunchAgent({...paths, root: "/tmp/a&b<c>"}, scheduled), /a&amp;b&lt;c&gt;/);
});
test("LaunchAgent paths must be absolute, existing, and not symlinks", () => {
  const {paths, root} = installable();
  assert.throws(() => validateLaunchAgentPaths({...paths, config: "targets/runtime.json"}), /absolute/);
  assert.throws(() => validateLaunchAgentPaths({...paths, cli: join(root, "missing.js")}), /does not exist/);
  symlinkSync(paths.config, join(root, "linked.json"));
  assert.throws(() => validateLaunchAgentPaths({...paths, config: join(root, "linked.json")}), /not a symlink/);
});
test("install and uninstall are explicit, idempotent, reversible, and confined to the given paths", () => {
  const {root, home, paths} = installable();
  const plistPath = launchAgentPath(home);
  const plist = renderLaunchAgent(paths, scheduled);
  assert.deepEqual(installLaunchAgent(plistPath, plist, root), {changed: true});
  assert.deepEqual(installLaunchAgent(plistPath, plist, root), {changed: false});
  assert.equal(readFileSync(plistPath, "utf8"), plist);
  assert.equal(statSync(plistPath).mode & 0o022, 0);
  assert.equal(statSync(join(root, ".runtime/logs")).mode & 0o777, 0o700);
  assert.equal(scheduleStatus({config: scheduled, root, now: due, plistPath, expectedPlist: plist, systemTimezone: "Australia/Melbourne"}).installedMatchesConfig, true);
  assert.equal(scheduleStatus({config: scheduled, root, now: due, plistPath, expectedPlist: plist.replace("3600", "60"), systemTimezone: "Australia/Melbourne"}).installedMatchesConfig, false);
  assert.deepEqual(uninstallLaunchAgent(plistPath), {removed: true});
  assert.equal(existsSync(plistPath), false);
  assert.deepEqual(uninstallLaunchAgent(plistPath), {removed: false});
});
test("uninstall never deletes a file it does not own, and install refuses a symlinked plist", () => {
  const {root, home, paths} = installable();
  const plistPath = launchAgentPath(home);
  mkdirSync(join(home, "Library/LaunchAgents"), {recursive: true});
  writeFileSync(plistPath, "<plist>someone else's agent</plist>");
  assert.throws(() => uninstallLaunchAgent(plistPath), /not this runtime's agent/);
  assert.ok(existsSync(plistPath));
  const other = join(root, "elsewhere.plist"); writeFileSync(other, "keep");
  const linked = join(home, "Library/LaunchAgents/linked.plist"); symlinkSync(other, linked);
  assert.throws(() => installLaunchAgent(linked, renderLaunchAgent(paths, scheduled), root), /symlink/);
  assert.throws(() => uninstallLaunchAgent(linked), /symlink/);
  assert.equal(readFileSync(other, "utf8"), "keep");
  assert.ok(lstatSync(linked).isSymbolicLink());
  assert.throws(() => launchAgentPath(undefined), /HOME/);
});
test("status reports states and codes only, never plan contents", async () => {
  const root = temporary();
  const before = scheduleStatus({config: scheduled, root, now: due, plistPath: join(root, "none.plist"), expectedPlist: null, systemTimezone: "Australia/Melbourne"});
  assert.equal(before.today, "never_run"); assert.equal(before.installed, false); assert.equal(before.lock, "free");
  assert.equal(existsSync(join(root, ".runtime")), false);
  await runScheduled({config: scheduled, source: counter().source, root, clock: at(due)});
  const after = scheduleStatus({config: scheduled, root, now: due, plistPath: join(root, "none.plist"), expectedPlist: null, systemTimezone: "Australia/Melbourne"});
  assert.equal(after.today, "success"); assert.equal(after.revision, 1); assert.equal(after.timezoneWarning, null);
  assert.doesNotMatch(JSON.stringify(after), /Example|https?:|example\.org/);
});
