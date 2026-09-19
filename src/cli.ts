import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { readKeychainToken } from "./credentials.js";
import { validate } from "./domain.js";
import { AppError, safeError } from "./errors.js";
import type { ErrorCode } from "./errors.js";
import { createNotionReader, NotionSnapshotSource } from "./notion.js";
import { digest, planMorning } from "./planner.js";
import { installLaunchAgent, LAUNCH_AGENT_LABEL, launchAgentPath, renderLaunchAgent, runScheduled, scheduleStatus,
  uninstallLaunchAgent, validateLaunchAgentPaths } from "./scheduler.js";
import { FileSnapshotSource } from "./source.js";
import { runMorning } from "./workflow.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const usage = `Usage: npm run morning:plan -- [--demo | --config targets/runtime.json] [--json] [--dry-run] [--no-record]
       npm run doctor -- [--demo | --config targets/runtime.json] [--json]
       npm run schedule -- <run | status | preview | install | uninstall> [--config targets/runtime.json]

Planning is always read-only for business data. Local audit/digest records are
stored privately in .runtime/runs.sqlite unless --no-record is supplied.
--demo explicitly uses fictional fixtures. It never contacts Notion.
--at <ISO timestamp with offset> injects a clock for reproducible offline checks.
Doctor validates the source and date contracts without creating local run records.

Scheduling (macOS LaunchAgent, see docs/runtime.md):
  schedule run        One unattended trigger: runs today's plan at most once, reading
                      the Notion token from the login Keychain. Quiet unless it ran.
  schedule status     Read-only: schedule, today's outcome, lease state. [--json] [--at]
  schedule preview    Print the LaunchAgent plist without writing anything.
  schedule install    Write the LaunchAgent plist, then print the launchctl command to load it.
  schedule uninstall  Remove the LaunchAgent plist, then print the launchctl command to unload it.
No command scans job boards or changes Notion.`;

const exitCodes: Partial<Record<ErrorCode, number>> = {NOTION: 3, STORAGE: 4, LOCKED: 5};
const scheduleOptions: Record<string, string[]> = {
  run: ["config", "at", "json"], status: ["config", "at", "json"], preview: ["config"], install: ["config"], uninstall: [],
};

async function main(): Promise<void> {
  let args: ReturnType<typeof parseCliArgs>;
  try { args = parseCliArgs(); } catch { throw new AppError("CONFIG", usage); }
  const {values, positionals} = args;
  if (values.help) { console.log(usage); return; }
  const [command, subcommand] = positionals;
  const valid = command === "schedule" ? positionals.length === 2 && subcommand !== undefined && subcommand in scheduleOptions
    : positionals.length === 1 && ["plan", "doctor"].includes(command ?? "");
  if (!valid) throw new AppError("CONFIG", usage);
  if (command === "schedule") {
    const allowed = scheduleOptions[subcommand ?? ""] ?? [];
    const extra = Object.keys(values).filter((name) => !allowed.includes(name));
    if (extra.length) throw new AppError("CONFIG", `schedule ${subcommand} does not accept --${extra.join(", --")}.`);
  }
  if (values.demo && values.config) throw new AppError("CONFIG", "Choose --demo or --config, not both.");
  if (values.at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(values.at)) {
    throw new AppError("CONFIG", "--at needs an ISO timestamp with seconds and a timezone offset.");
  }
  const now = values.at ? new Date(values.at) : new Date();
  if (command === "schedule" && subcommand === "uninstall") {
    const plistPath = launchAgentPath(process.env.HOME);
    const {removed} = uninstallLaunchAgent(plistPath);
    console.log(removed ? `Removed ${plistPath}.\nIf it is loaded, unload it now with:\n  launchctl bootout gui/${process.getuid?.() ?? "$(id -u)"}/${LAUNCH_AGENT_LABEL}`
      : `No LaunchAgent is installed at ${plistPath}. Nothing changed.`);
    return;
  }
  const configPath = resolve(root, values.config ?? "targets/runtime.json");
  const config: Config = values.demo ? validate(configSchema, {
    schemaVersion: 1, timezone: "Australia/Melbourne",
    source: {driver: "snapshot", path: resolve(root, "tests/fixtures/snapshot.json")},
  }, "Demo configuration") : await loadConfig(configPath);
  // Manual runs read NOTION_TOKEN from the environment; scheduled runs read the Keychain.
  const source = (token: () => string | undefined) => () => config.source.driver === "snapshot" ? new FileSnapshotSource(config.source.path)
    : new NotionSnapshotSource(config.source, createNotionReader(config.source, token()));
  const environmentToken = () => process.env[config.source.driver === "notion" ? config.source.tokenEnv : "NOTION_TOKEN"];
  if (command === "doctor") {
    const snapshot = await source(environmentToken)().read();
    const plan = planMorning(snapshot, now, config.timezone);
    const result = {status: "ok", source: config.source.driver, timezone: config.timezone,
      counts: plan.counts, warning: config.source.driver === "notion" && config.source.frequency.mode === "fixed"
        ? "Frequency is explicitly fixed by local configuration, not read from Notion." : null};
    console.log(values.json ? JSON.stringify(result, null, 2) : `Doctor: valid ${result.source} schema and records (${result.timezone}). ${result.counts.reviews} items need review.${result.warning ? ` ${result.warning}` : ""}`);
    return;
  }
  if (command === "plan") {
    const plan = await runMorning({config, source: source(environmentToken), root, clock: {now: () => now}, record: !values["no-record"]});
    console.log(values.json ? JSON.stringify(plan, null, 2) : `${values.demo ? "Fictional demo data\n" : ""}${digest(plan)}`);
    return;
  }
  if (subcommand === "run") {
    const result = await runScheduled({config, source: source(() => readKeychainToken()), root, clock: {now: () => now}});
    // Only counts and codes reach the launchd log: never company names, URLs, or notes.
    const summary = {outcome: result.outcome, date: result.date, ...(result.plan ? {counts: result.plan.counts} : {}),
      ...(result.errorCode ? {error: result.errorCode} : {})};
    if (values.json) console.log(JSON.stringify(summary));
    else if (result.outcome === "success") console.log(`${now.toISOString()} scheduled plan ${result.date}: ${result.plan?.counts.dueTargets} targets due, ${result.plan?.counts.followUps} follow-ups, ${result.plan?.counts.reviews} reviews.`);
    else if (result.outcome === "busy") console.log(`${now.toISOString()} scheduled run skipped: another run holds the lease.`);
    if (result.errorCode) {
      console.error(JSON.stringify({at: now.toISOString(), error: result.errorCode, message: "Scheduled run failed; see npm run schedule -- status and docs/runtime.md."}));
      process.exitCode = exitCodes[result.errorCode] ?? 2;
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
      `Today (${status.date}): ${status.today}${status.errorCode ? ` [${status.errorCode}]` : ""}${status.lastObservedAt ? ` at ${status.lastObservedAt}` : ""}; scheduled failures ${status.scheduledFailures}; lease ${status.lease}`,
      ...(status.timezoneWarning ? [`Warning: ${status.timezoneWarning}`] : []),
    ].join("\n"));
    return;
  }
  const plist = renderLaunchAgent(paths(), config);
  if (subcommand === "preview") { process.stdout.write(plist); return; }
  if (process.platform !== "darwin") throw new AppError("CONFIG", "schedule install writes a macOS LaunchAgent and only runs on macOS.");
  const plistPath = launchAgentPath(process.env.HOME);
  const {changed} = installLaunchAgent(plistPath, plist, root);
  const domain = `gui/${process.getuid?.() ?? "$(id -u)"}`;
  console.log(`${changed ? "Wrote" : "Already current:"} ${plistPath}\nLoad it now (or log out and back in) with:\n  launchctl bootout ${domain}/${LAUNCH_AGENT_LABEL} 2>/dev/null; launchctl bootstrap ${domain} ${plistPath}\nDisable any time with schedule.enabled: false in the runtime config.`);
}

function parseCliArgs() {
  return parseArgs({strict: true, allowPositionals: true, options: {
    config: {type: "string"}, demo: {type: "boolean"}, json: {type: "boolean"},
    "dry-run": {type: "boolean"}, "no-record": {type: "boolean"}, at: {type: "string"}, help: {type: "boolean"},
  }});
}

main().catch((error: unknown) => {
  const failure = safeError(error);
  console.error(JSON.stringify({error: failure.code, message: failure.message}));
  process.exitCode = exitCodes[failure.code] ?? 2;
});
