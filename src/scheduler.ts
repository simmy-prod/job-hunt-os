import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Config } from "./config.js";
import { AppError, safeError } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { RunLedger } from "./ledger.js";
import { acquireLock, inspectLock } from "./lock.js";
import type { Lock } from "./lock.js";
import { businessDate } from "./planner.js";
import type { Plan } from "./planner.js";
import { executeRun, logicalKey } from "./workflow.js";
import type { RunOptions } from "./workflow.js";

export const LAUNCH_AGENT_LABEL = "local.job-hunt-os.morning-plan";
// Scheduled retries per logical key before the scheduler stops for that day.
export const MAX_SCHEDULED_FAILURES = 3;
// Hourly re-check: a cheap no-op once the day succeeded, the retry path otherwise.
export const RECHECK_INTERVAL_SECONDS = 3600;

export type ScheduledOutcome = "disabled" | "not_due" | "already_succeeded" | "busy" | "attempts_exhausted" | "success" | "failed";
export interface ScheduledResult {
  outcome: ScheduledOutcome;
  date: string;
  plan?: Plan;
  errorCode?: ErrorCode;
}

// Wall-clock HH:MM in the business timezone, independent of the system timezone.
export function localTime(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(now);
  return `${parts.find((part) => part.type === "hour")?.value}:${parts.find((part) => part.type === "minute")?.value}`;
}

// One unattended trigger. Every early exit happens before credentials are read or
// Notion is contacted; only a due, unlocked, not-yet-successful day reaches the source.
export async function runScheduled(options: RunOptions): Promise<ScheduledResult> {
  const {config} = options;
  const now = options.clock.now();
  const date = businessDate(now, config.timezone);
  if (!config.schedule?.enabled) return {outcome: "disabled", date};
  if (localTime(now, config.timezone) < config.schedule.time) return {outcome: "not_due", date};
  const key = logicalKey(config, now);
  // The same single-instance lock as manual recorded runs, covering the remote read.
  let lock: Lock;
  try { lock = acquireLock(options.root); }
  catch (error) {
    if (error instanceof AppError && error.code === "LOCKED") return {outcome: "busy", date};
    throw error;
  }
  let ledger: RunLedger | undefined;
  try {
    ledger = new RunLedger(options.root);
    if (ledger.latestStatus(key) === "success") return {outcome: "already_succeeded", date};
    if (ledger.failedAttempts(key, "scheduled") >= MAX_SCHEDULED_FAILURES) return {outcome: "attempts_exhausted", date};
    try { return {outcome: "success", date, plan: await executeRun(ledger, options, now, "scheduled")}; }
    catch (error) { return {outcome: "failed", date, errorCode: safeError(error).code}; }
  } finally {
    ledger?.close();
    lock.release();
  }
}

export interface LaunchAgentPaths {
  node: string;
  cli: string;
  config: string;
  root: string;
}

function assertPlainPath(path: string, kind: "file" | "directory", label: string): void {
  if (!isAbsolute(path) || /[\p{Cc}]/u.test(path)) throw new AppError("CONFIG", `${label} must be an absolute path without control characters.`);
  if (!existsSync(path)) throw new AppError("CONFIG", `${label} does not exist. Run npm run compile first and install from the main checkout.`);
  const stat = lstatSync(path);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw new AppError("CONFIG", `${label} must be a real ${kind}, not a symlink.`);
}

export function validateLaunchAgentPaths(paths: LaunchAgentPaths): LaunchAgentPaths {
  assertPlainPath(paths.node, "file", "Node binary");
  assertPlainPath(paths.cli, "file", "Compiled CLI (dist/src/cli.js)");
  assertPlainPath(paths.config, "file", "Runtime config");
  assertPlainPath(paths.root, "directory", "Repository root");
  return paths;
}

export function logPath(root: string): string { return join(root, ".runtime", "logs", "scheduler.log"); }

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// The plist carries paths and a schedule only. No token, no token-bearing
// environment variable, and no shell: launchd runs Node directly.
export function renderLaunchAgent(paths: LaunchAgentPaths, config: Config): string {
  if (!config.schedule?.enabled) throw new AppError("CONFIG", "Set schedule.enabled to true in the runtime config before installing the scheduler.");
  const [hour, minute] = config.schedule.time.split(":").map(Number);
  const args = [paths.node, paths.cli, "schedule", "run", "--config", paths.config];
  const log = logPath(paths.root);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(paths.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StartInterval</key>
  <integer>${RECHECK_INTERVAL_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function launchAgentPath(home: string | undefined): string {
  if (!home || !isAbsolute(home)) throw new AppError("CONFIG", "HOME must be an absolute path to locate ~/Library/LaunchAgents.");
  return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new AppError("STORAGE", "Private runtime paths must be local directories, not symlinks.");
  } else {
    mkdirSync(path, {mode: 0o700});
  }
  chmodSync(path, 0o700);
}

function refuseSymlink(path: string): void {
  if (lstatExists(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile())) {
    throw new AppError("CONFIG", "The LaunchAgent path is a symlink or not a regular file. Remove it by hand before continuing.");
  }
}

// Writes only the plist (atomically, 0644 as launchd requires) and the private log directory.
export function installLaunchAgent(plistPath: string, plist: string, root: string): {changed: boolean} {
  ensurePrivateDirectory(join(root, ".runtime"));
  ensurePrivateDirectory(join(root, ".runtime", "logs"));
  mkdirSync(join(plistPath, ".."), {recursive: true});
  refuseSymlink(plistPath);
  if (existsSync(plistPath) && readFileSync(plistPath, "utf8") === plist) return {changed: false};
  const temporary = `${plistPath}.${process.pid}.tmp`;
  writeFileSync(temporary, plist, {mode: 0o644, flag: "wx"});
  renameSync(temporary, plistPath);
  return {changed: true};
}

export function uninstallLaunchAgent(plistPath: string): {removed: boolean} {
  if (!lstatExists(plistPath)) return {removed: false};
  refuseSymlink(plistPath);
  if (!readFileSync(plistPath, "utf8").includes(`<string>${LAUNCH_AGENT_LABEL}</string>`)) {
    throw new AppError("CONFIG", "The file at the LaunchAgent path is not this runtime's agent. It was left untouched.");
  }
  unlinkSync(plistPath);
  return {removed: true};
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

export interface ScheduleStatus {
  enabled: boolean;
  time: string | null;
  timezone: string;
  systemTimezone: string;
  timezoneWarning: string | null;
  installed: boolean;
  installedMatchesConfig: boolean | null;
  date: string;
  today: "never_run" | "success" | "failed" | "attempts_exhausted";
  lastObservedAt: string | null;
  revision: number | null;
  errorCode: string | null;
  scheduledFailures: number;
  lock: "free" | "held" | "stale";
}

// Read-only: reports only dates, counts, states, and error codes, never plan contents.
export function scheduleStatus(options: {config: Config; root: string; now: Date; plistPath: string; expectedPlist: string | null;
  systemTimezone: string;}): ScheduleStatus {
  const {config, now} = options;
  const key = logicalKey(config, now);
  const latest = RunLedger.readLatest(options.root, key);
  const view = {latest: latest?.logicalKey === key ? latest : undefined,
    scheduledFailures: RunLedger.readScheduledFailures(options.root, key)};
  const installed = lstatExists(options.plistPath);
  const plainFile = installed && lstatSync(options.plistPath).isFile();
  const today = !view.latest ? "never_run" : view.latest.status === "success" ? "success"
    : view.scheduledFailures >= MAX_SCHEDULED_FAILURES ? "attempts_exhausted" : "failed";
  return {
    enabled: config.schedule?.enabled ?? false,
    time: config.schedule?.time ?? null,
    timezone: config.timezone,
    systemTimezone: options.systemTimezone,
    timezoneWarning: options.systemTimezone === config.timezone ? null
      : "System timezone differs from the business timezone. launchd's calendar trigger follows the system clock; the hourly re-check still runs the plan within an hour of the configured business time.",
    installed,
    installedMatchesConfig: !installed ? null
      : plainFile && options.expectedPlist !== null && readFileSync(options.plistPath, "utf8") === options.expectedPlist,
    date: businessDate(now, config.timezone),
    today,
    lastObservedAt: view.latest?.observedAt ?? null,
    revision: view.latest?.revision ?? null,
    errorCode: view.latest?.errorCode ?? null,
    scheduledFailures: view.scheduledFailures,
    lock: inspectLock(options.root),
  };
}
