import { accessSync, constants, existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { ErrorCode } from "./errors.js";
import { safeError } from "./errors.js";
import { planMorning } from "./planner.js";
import type { Plan } from "./planner.js";
import type { SnapshotSource } from "./source.js";

export interface NodeCheck { ok: boolean; current: string; required: string | null; }
export interface RuntimeDirCheck { ok: boolean; exists: boolean; mode: string | null; reason: string | null; }
export interface GitignoreCheck { ok: boolean; missing: string[]; }
export interface ConfigCheck { ok: boolean; driver: "snapshot" | "notion" | null; timezone: string | null; message: string | null; }
export interface SourceCheck { ok: boolean; skipped: boolean; message: string | null; }

export interface DoctorReport {
  ok: boolean;
  worstCode: ErrorCode | null;
  checks: {
    node: NodeCheck;
    runtimeDir: RuntimeDirCheck;
    gitignore: GitignoreCheck;
    config: ConfigCheck;
    source: SourceCheck;
  };
  counts: Plan["counts"] | null;
  warning: string | null;
}

function parseVersion(value: string): [number, number, number] {
  const parts = value.replace(/^>=\s*/, "").split(".").map((part) => Number(part.replace(/\D.*$/, "")) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function meetsMinimum(current: string, minimum: string): boolean {
  const [cMaj, cMin, cPatch] = parseVersion(current);
  const [mMaj, mMin, mPatch] = parseVersion(minimum);
  if (cMaj !== mMaj) return cMaj > mMaj;
  if (cMin !== mMin) return cMin > mMin;
  return cPatch >= mPatch;
}

export function checkNodeVersion(root: string): NodeCheck {
  const current = process.versions.node;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {engines?: {node?: string}};
    const required = pkg.engines?.node ?? null;
    return {ok: required ? meetsMinimum(current, required) : true, current, required};
  } catch {
    return {ok: false, current, required: null};
  }
}

export function checkRuntimeDir(root: string): RuntimeDirCheck {
  const directory = join(root, ".runtime");
  try {
    if (!existsSync(directory)) {
      // Nothing to protect yet; confirm a future run could create it.
      accessSync(root, constants.W_OK);
      return {ok: true, exists: false, mode: null, reason: null};
    }
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink()) return {ok: false, exists: true, mode: null, reason: "symlink"};
    if (!stat.isDirectory()) return {ok: false, exists: true, mode: null, reason: "not_a_directory"};
    const mode = (stat.mode & 0o777).toString(8);
    return {ok: mode === "700", exists: true, mode, reason: mode === "700" ? null : "unexpected_permissions"};
  } catch {
    return {ok: false, exists: existsSync(directory), mode: null, reason: "unreadable"};
  }
}

const REQUIRED_GITIGNORE_ENTRIES = ["profile/", "pipeline/", "prep/", "targets/", ".runtime/", ".env"];

export function checkGitignore(root: string): GitignoreCheck {
  try {
    const lines = readFileSync(join(root, ".gitignore"), "utf8").split("\n").map((line) => line.trim());
    const missing = REQUIRED_GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));
    return {ok: missing.length === 0, missing};
  } catch {
    return {ok: false, missing: REQUIRED_GITIGNORE_ENTRIES};
  }
}

// Runs every check independently so a single broken check (a bad config, an
// unreachable Notion source) never hides the results of the others. This is
// the one command that deliberately reports partial diagnostics instead of
// throwing on the first failure: an operator running `doctor` by hand wants
// the whole picture, not just the first thing that broke.
export async function runDoctorReport(options: {
  root: string;
  resolveConfig: () => Promise<Config>;
  buildSource: (config: Config) => SnapshotSource;
  now: Date;
}): Promise<DoctorReport> {
  const node = checkNodeVersion(options.root);
  const runtimeDir = checkRuntimeDir(options.root);
  const gitignore = checkGitignore(options.root);

  let config: Config | null = null;
  let configCheck: ConfigCheck;
  let worstCode: ErrorCode | null = null;
  try {
    config = await options.resolveConfig();
    configCheck = {ok: true, driver: config.source.driver, timezone: config.timezone, message: null};
  } catch (error) {
    const failure = safeError(error);
    worstCode = failure.code;
    configCheck = {ok: false, driver: null, timezone: null, message: failure.message};
  }

  let sourceCheck: SourceCheck = {ok: true, skipped: true, message: null};
  let counts: Plan["counts"] | null = null;
  let warning: string | null = null;
  if (config) {
    try {
      const snapshot = await options.buildSource(config).read();
      const plan = planMorning(snapshot, options.now, config.timezone);
      counts = plan.counts;
      sourceCheck = {ok: true, skipped: false, message: null};
      if (config.source.driver === "notion" && config.source.frequency.mode === "fixed") {
        warning = "Frequency is explicitly fixed by local configuration, not read from Notion.";
      }
    } catch (error) {
      const failure = safeError(error);
      worstCode = worstCode ?? failure.code;
      sourceCheck = {ok: false, skipped: false, message: failure.message};
    }
  }

  const ok = node.ok && runtimeDir.ok && gitignore.ok && configCheck.ok && sourceCheck.ok;
  return {
    ok, worstCode: ok ? null : worstCode ?? "CONFIG",
    checks: {node, runtimeDir, gitignore, config: configCheck, source: sourceCheck},
    counts, warning,
  };
}
