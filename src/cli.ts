import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { configSchema, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { readKeychainToken, tryReadKeychainToken } from "./credentials.js";
import { validate } from "./domain.js";
import { runDoctorReport } from "./doctor.js";
import type { DoctorReport } from "./doctor.js";
import { AppError, exitCodeFor, safeError } from "./errors.js";
import { RunLedger } from "./ledger.js";
import { createNotionReader, NotionSnapshotSource } from "./notion.js";
import { createNotionWriter, WRITE_TOKEN_ENV } from "./notion-writer.js";
import { businessDate, digest } from "./planner.js";
import { installLaunchAgent, LAUNCH_AGENT_LABEL, launchAgentPath, renderLaunchAgent, runScheduled, scheduleStatus,
  uninstallLaunchAgent, validateLaunchAgentPaths } from "./scheduler.js";
import { FileSnapshotSource } from "./source.js";
import { logicalKeyPrefix, runMorning } from "./workflow.js";
import { applyWrites, approveWrite, listWrites, proposeWrite, readWriteCounts, rejectWrite } from "./write-workflow.js";
import type { Prompter, WriteCounts } from "./write-workflow.js";
import { intentFields, parseWriteRequest } from "./writes.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const commands = ["plan", "doctor", "status", "schedule", "writes"];
const usage = `Usage: npm run morning:plan -- [--demo | --config targets/runtime.json] [--json] [--dry-run] [--no-record]
       npm run doctor -- [--demo | --config targets/runtime.json] [--json]
       node dist/src/cli.js status [--demo | --config targets/runtime.json] [--json]
       npm run schedule -- <run | status | preview | install | uninstall> [--config targets/runtime.json]

Planning is always read-only for business data. Local audit/digest records are
stored privately in .runtime/runs.sqlite unless --dry-run or --no-record is
supplied; both suppress the ledger write, and output is marked "dryRun" when
--dry-run was requested. --dry-run and --no-record are only accepted with
plan: doctor and status never write to the ledger, so they would have no
effect there.
--demo explicitly uses fictional fixtures. It never contacts Notion.
--at <ISO timestamp with offset> injects a clock for reproducible offline checks.
Doctor validates Node version, configuration, the private runtime directory,
gitignore coverage, and the source/schema, without creating local run records.
Status reports the latest recorded run (never-run, success, failed, or stale)
for the current configuration, reading only the local ledger.

Scheduling (macOS LaunchAgent, see docs/runtime.md):
  schedule run        One unattended trigger: runs today's plan at most once, reading
                      the Notion token from the login Keychain. Quiet unless it ran.
                      [--json] [--at]
  schedule status     Read-only: schedule, today's outcome, lock state. [--json] [--at]
  schedule preview    Print the LaunchAgent plist without writing anything.
  schedule install    Write the LaunchAgent plist, then print the launchctl command to load it.
  schedule uninstall  Remove the LaunchAgent plist, then print the launchctl command to unload it.
Allowlisted Notion writes (manual only, see docs/runtime.md "Write contract"):
  writes propose <operation> --id <record id> [--date YYYY-MM-DD] [--action <text>] [--stage <stage>]
                      [--demo | --config <path>] [--json] [--at]
  writes approve <intent id> [--confirm-submitted]   Interactive terminal only.
  writes reject <intent id> [--json]
  writes apply [--dry-run | --execute] [--demo | --config <path>] [--json] [--at]
                      Dry run unless --execute. --execute reads ${WRITE_TOKEN_ENV} from the environment.
  writes status [--json]
plan, doctor, status, and schedule never change Notion. No command scans job
boards, submits an application, or sends a message.`;

// Every accepted option is used by the subcommand; anything else is rejected.
const writeOptions: Record<string, string[]> = {
  propose: ["config", "demo", "json", "at", "id", "date", "action", "stage"],
  approve: ["confirm-submitted", "at"],
  reject: ["json", "at"],
  apply: ["config", "demo", "json", "at", "dry-run", "execute"],
  status: ["json"],
};
const writeOnlyOptions = ["id", "date", "action", "stage", "execute", "confirm-submitted"] as const;
type Values = ReturnType<typeof parseCliArgs>["values"];

const scheduleOptions: Record<string, string[]> = {
  run: ["config", "at", "json"], status: ["config", "at", "json"], preview: ["config"], install: ["config"], uninstall: [],
};

async function main(): Promise<void> {
  let args: ReturnType<typeof parseCliArgs>;
  try { args = parseCliArgs(); } catch { throw new AppError("CONFIG", usage); }
  const {values, positionals} = args;
  if (values.help) { console.log(usage); return; }
  const [command, subcommand] = positionals;
  const valid = command === "writes" ? subcommand !== undefined && subcommand in writeOptions
    && positionals.length === (["propose", "approve", "reject"].includes(subcommand) ? 3 : 2)
    : command === "schedule" ? positionals.length === 2 && subcommand !== undefined && subcommand in scheduleOptions
      : positionals.length === 1 && commands.includes(command ?? "");
  if (!valid) throw new AppError("CONFIG", usage);
  if (command === "schedule") {
    const allowed = scheduleOptions[subcommand ?? ""] ?? [];
    const extra = Object.keys(values).filter((name) => !allowed.includes(name));
    if (extra.length) throw new AppError("CONFIG", `schedule ${subcommand} does not accept --${extra.join(", --")}.`);
  }
  if (command === "writes") {
    const allowed = writeOptions[subcommand ?? ""] ?? [];
    const extra = Object.keys(values).filter((name) => !allowed.includes(name));
    if (extra.length) throw new AppError("CONFIG", `writes ${subcommand} does not accept --${extra.join(", --")}.`);
  } else {
    const writeOnly = writeOnlyOptions.filter((name) => values[name] !== undefined);
    if (writeOnly.length) throw new AppError("CONFIG", `--${writeOnly.join(", --")} only applies to writes commands.`);
  }
  if (values.demo && values.config) throw new AppError("CONFIG", "Choose --demo or --config, not both.");
  if (command !== "plan" && command !== "writes" && (values["dry-run"] || values["no-record"])) {
    throw new AppError("CONFIG", "--dry-run and --no-record only apply to plan; doctor and status never write to the ledger.");
  }
  if (values.at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(values.at)) {
    throw new AppError("CONFIG", "--at needs an ISO timestamp with seconds and a timezone offset.");
  }
  const now = values.at ? new Date(values.at) : new Date();
  const resolveConfig = (): Promise<Config> => values.demo ? Promise.resolve(validate(configSchema, {
    schemaVersion: 1, timezone: "Australia/Melbourne",
    source: {driver: "snapshot", path: resolve(root, "tests/fixtures/snapshot.json")},
  }, "Demo configuration")) : loadConfig(resolve(root, values.config ?? "targets/runtime.json"));
  // Manual runs read NOTION_TOKEN from the environment; scheduled runs read the Keychain.
  const buildSource = (config: Config, token = () => config.source.driver === "notion" ? process.env[config.source.tokenEnv] : undefined) =>
    config.source.driver === "snapshot" ? new FileSnapshotSource(config.source.path)
      : new NotionSnapshotSource(config.source, createNotionReader(config.source, token()));

  if (command === "writes") {
    await writes(subcommand ?? "", positionals[2], values, now, resolveConfig, buildSource);
    return;
  }
  if (command === "schedule") {
    await schedule(subcommand ?? "", values, now, resolveConfig, buildSource);
    return;
  }

  if (command === "doctor") {
    const report = await runDoctorReport({root, resolveConfig, buildSource, now});
    console.log(values.json ? JSON.stringify(report, null, 2) : renderDoctorText(report));
    process.exitCode = report.ok ? 0 : exitCodeFor(report.worstCode ?? "CONFIG");
    return;
  }
  if (command === "status") {
    const config = await resolveConfig();
    const date = businessDate(now, config.timezone);
    const latest = RunLedger.readLatest(root, logicalKeyPrefix(config));
    const latestDate = latest ? latest.logicalKey.split(":").pop() ?? null : null;
    const state = !latest ? "never_run" : latestDate !== date ? "stale" : latest.status;
    const result = {
      state, date, timezone: config.timezone, latestRunDate: latestDate,
      revision: latest?.revision ?? null,
      errorCode: state === "failed" ? latest?.errorCode ?? null : null,
      writes: readWriteCounts(root, config),
    };
    console.log(values.json ? JSON.stringify(result, null, 2) : renderStatusText(result));
    return;
  }
  const config = await resolveConfig();
  const dryRun = Boolean(values["dry-run"]);
  const plan = await runMorning({config, source: () => buildSource(config), root, clock: {now: () => now}, record: !values["no-record"], dryRun});
  console.log(values.json ? JSON.stringify({...plan, dryRun}, null, 2)
    : `${values.demo ? "Fictional demo data\n" : ""}${dryRun ? "Dry run: nothing written to the ledger\n" : ""}${digest(plan)}`);
}

async function writes(subcommand: string, argument: string | undefined, values: Values, now: Date,
  resolveConfig: () => Promise<Config>, buildSource: (config: Config) => FileSnapshotSource | NotionSnapshotSource): Promise<void> {
  const clock = {now: () => values.at ? now : new Date()};
  const print = (json: unknown, text: string) => console.log(values.json ? JSON.stringify(json, null, 2) : text);
  if (subcommand === "propose") {
    // Policy validation happens before any config, storage, or network access.
    const request = parseWriteRequest({operation: argument, recordId: values.id,
      ...(values.date === undefined ? {} : {date: values.date}), ...(values.action === undefined ? {} : {action: values.action}),
      ...(values.stage === undefined ? {} : {stage: values.stage})});
    const config = await resolveConfig();
    const {intent, duplicate} = await proposeWrite({config, source: () => buildSource(config), root, clock, request});
    const next = intent.state === "awaiting_approval" ? `npm run writes -- approve ${intent.id}` : "npm run writes -- apply";
    print({id: intent.id, operation: intent.operation, state: intent.state, duplicate},
      `${duplicate ? "Already proposed" : "Proposed"} ${intent.id}: ${intent.operation} (${intent.state}). Next: ${next}`);
    return;
  }
  if (subcommand === "approve") {
    // Checked before storage is opened: schedulers, pipes, CI, and agents cannot approve.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new AppError("POLICY", "Approval needs an interactive terminal. Schedulers, pipes, CI jobs, and coding agents cannot approve writes.");
    }
    const lines = createInterface({input: process.stdin, output: process.stdout});
    const prompter: Prompter = {show: (line) => console.log(line), ask: (question) => lines.question(question)};
    try {
      const intent = await approveWrite({root, clock, id: argument!, attestSubmitted: values["confirm-submitted"] === true, prompter});
      console.log(`Approved ${intent.id}. Nothing was sent. Next: npm run writes -- apply`);
    } finally { lines.close(); }
    return;
  }
  if (subcommand === "reject") {
    const intent = rejectWrite({root, clock, id: argument!});
    print({id: intent.id, state: intent.state}, `Rejected ${intent.id}. Nothing was sent.`);
    return;
  }
  if (subcommand === "status") {
    const intents = listWrites(root).map((intent) => ({id: intent.id, operation: intent.operation, recordId: intent.recordId,
      state: intent.state, fields: intentFields(intent), attempts: intent.attempts, lastError: intent.lastError}));
    print(intents, intents.length ? intents.map((item) => `${item.id} ${item.state} ${item.operation} ${item.recordId} [${item.fields.join(", ")}]${item.lastError ? ` last error ${item.lastError}` : ""}`).join("\n") : "No write intents.");
    return;
  }
  if (values.execute && values["dry-run"]) throw new AppError("CONFIG", "Choose --dry-run or --execute, not both.");
  const config = await resolveConfig();
  const execute = values.execute === true;
  if (execute && config.source.driver !== "notion") throw new AppError("CONFIG", "--execute needs a Notion source. Demo and snapshot sources only support dry runs.");
  const result = await applyWrites({config, root, clock, execute, writer: () => {
    if (config.source.driver !== "notion") throw new AppError("CONFIG", "Writes need a Notion source.");
    // The write token must differ from every read credential: the env token and the Keychain token used by scheduled runs.
    return createNotionWriter(config.source, {write: process.env[WRITE_TOKEN_ENV],
      read: [process.env[config.source.tokenEnv], tryReadKeychainToken()]});
  }});
  print(result, [`${result.mode === "dry_run" ? "Dry run: nothing was sent." : "Executed."} ${result.results.length} open intents.`,
    ...result.results.map((item) => `- ${item.id} ${item.operation} ${item.recordId} [${item.fields.join(", ")}]: ${item.outcome}${item.reason && item.reason !== item.outcome ? ` (${item.reason})` : ""}${item.errorCode ? ` (${item.errorCode})` : ""}`)].join("\n"));
  // Any failed, conflicted, or retrying intent is a remote-side problem: exit like a NOTION failure.
  if (!result.ok) process.exitCode = exitCodeFor("NOTION");
}

async function schedule(subcommand: string, values: {config?: string; json?: boolean}, now: Date,
  resolveConfig: () => Promise<Config>, buildSource: (config: Config, token: () => string | undefined) => FileSnapshotSource | NotionSnapshotSource): Promise<void> {
  const domain = `gui/${process.getuid?.() ?? "$(id -u)"}`;
  if (subcommand === "uninstall") {
    const plistPath = launchAgentPath(process.env.HOME);
    const {removed} = uninstallLaunchAgent(plistPath);
    console.log(removed ? `Removed ${plistPath}.\nIf it is loaded, unload it now with:\n  launchctl bootout ${domain}/${LAUNCH_AGENT_LABEL}`
      : `No LaunchAgent is installed at ${plistPath}. Nothing changed.`);
    return;
  }
  const configPath = resolve(root, values.config ?? "targets/runtime.json");
  const config = await resolveConfig();
  if (subcommand === "run") {
    const result = await runScheduled({config, source: () => buildSource(config, () => readKeychainToken()), root, clock: {now: () => now}});
    // Only counts and codes reach the launchd log: never company names, URLs, or notes.
    const summary = {outcome: result.outcome, date: result.date, ...(result.plan ? {counts: result.plan.counts} : {}),
      ...(result.errorCode ? {error: result.errorCode} : {})};
    if (values.json) console.log(JSON.stringify(summary));
    else if (result.outcome === "success") console.log(`${now.toISOString()} scheduled plan ${result.date}: ${result.plan?.counts.dueTargets} targets due, ${result.plan?.counts.followUps} follow-ups, ${result.plan?.counts.reviews} reviews.`);
    else if (result.outcome === "busy") console.log(`${now.toISOString()} scheduled run skipped: another run holds the lock.`);
    if (result.errorCode) {
      console.error(JSON.stringify({at: now.toISOString(), error: result.errorCode, message: "Scheduled run failed; see npm run schedule -- status and docs/runtime.md."}));
      process.exitCode = exitCodeFor(result.errorCode);
    }
    return;
  }
  const paths = () => validateLaunchAgentPaths({node: process.execPath, cli: fileURLToPath(import.meta.url), config: configPath, root});
  if (subcommand === "status") {
    const plistPath = launchAgentPath(process.env.HOME);
    let expected: string | null;
    try { expected = renderLaunchAgent(paths(), config); } catch { expected = null; }
    const status = scheduleStatus({config, root, now, plistPath, expectedPlist: expected,
      systemTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone});
    console.log(values.json ? JSON.stringify(status, null, 2) : [
      `Schedule: ${status.enabled ? `enabled at ${status.time}` : "disabled"} (${status.timezone})`,
      `LaunchAgent: ${!status.installed ? "not installed" : status.installedMatchesConfig ? "installed, current" : "installed, out of date: rerun schedule install"}`,
      `Today (${status.date}): ${status.today}${status.errorCode ? ` [${status.errorCode}]` : ""}${status.lastObservedAt ? ` at ${status.lastObservedAt}` : ""}; scheduled failures ${status.scheduledFailures}; lock ${status.lock}`,
      ...(status.timezoneWarning ? [`Warning: ${status.timezoneWarning}`] : []),
    ].join("\n"));
    return;
  }
  const plist = renderLaunchAgent(paths(), config);
  if (subcommand === "preview") { process.stdout.write(plist); return; }
  if (process.platform !== "darwin") throw new AppError("CONFIG", "schedule install writes a macOS LaunchAgent and only runs on macOS.");
  const plistPath = launchAgentPath(process.env.HOME);
  const {changed} = installLaunchAgent(plistPath, plist, root);
  console.log(`${changed ? "Wrote" : "Already current:"} ${plistPath}\nLoad it now (or log out and back in) with:\n  launchctl bootout ${domain}/${LAUNCH_AGENT_LABEL} 2>/dev/null; launchctl bootstrap ${domain} ${plistPath}\nDisable any time with schedule.enabled: false in the runtime config.`);
}

function renderDoctorText(report: DoctorReport): string {
  const lines = [`Doctor: ${report.ok ? "all checks passed" : "one or more checks failed"}`,
    `- Node ${report.checks.node.ok ? "OK" : "FAILED"} (have ${report.checks.node.current}, need ${report.checks.node.required ?? "unspecified"})`,
    `- .runtime directory ${report.checks.runtimeDir.ok ? "OK" : `FAILED (${report.checks.runtimeDir.reason ?? "unknown"})`}`,
    `- gitignore coverage ${report.checks.gitignore.ok ? "OK" : `MISSING: ${report.checks.gitignore.missing.join(", ")}`}`,
    `- configuration ${report.checks.config.ok ? `OK (${report.checks.config.driver}, ${report.checks.config.timezone})` : `FAILED: ${report.checks.config.message}`}`,
    `- source/schema ${report.checks.source.skipped ? "SKIPPED (no configuration)" : report.checks.source.ok ? "OK" : `FAILED: ${report.checks.source.message}`}`,
  ];
  if (report.counts) lines.push(`${report.counts.reviews} items need review.`);
  if (report.warning) lines.push(report.warning);
  return lines.join("\n");
}

function renderStatusText(result: {state: string; date: string; timezone: string; latestRunDate: string | null; revision: number | null; errorCode: string | null; writes: WriteCounts | null}): string {
  const lines = [`Status: ${result.state} (today ${result.date}, ${result.timezone})`];
  if (result.latestRunDate) lines.push(`Latest recorded run: ${result.latestRunDate}${result.revision !== null ? ` (revision ${result.revision})` : ""}`);
  else lines.push("No run has been recorded for this configuration yet.");
  if (result.state === "stale") lines.push("The workflow has not completed a run for today yet.");
  if (result.errorCode) lines.push(`Last error class: ${result.errorCode}`);
  const w = result.writes;
  if (w) lines.push(`Writes: ${w.awaitingApproval} awaiting approval, ${w.approved} approved, ${w.inFlight} in flight, ${w.failed} failed, ${w.conflict} conflicted`);
  return lines.join("\n");
}

function parseCliArgs() {
  return parseArgs({strict: true, allowPositionals: true, options: {
    config: {type: "string"}, demo: {type: "boolean"}, json: {type: "boolean"},
    "dry-run": {type: "boolean"}, "no-record": {type: "boolean"}, at: {type: "string"}, help: {type: "boolean"},
    id: {type: "string"}, date: {type: "string"}, action: {type: "string"}, stage: {type: "string"},
    execute: {type: "boolean"}, "confirm-submitted": {type: "boolean"},
  }});
}

main().catch((error: unknown) => {
  const failure = safeError(error);
  console.error(JSON.stringify({error: failure.code, message: failure.message}));
  process.exitCode = exitCodeFor(failure.code);
});
