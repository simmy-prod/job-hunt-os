import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { validate } from "./domain.js";
import { runDoctorReport } from "./doctor.js";
import type { DoctorReport } from "./doctor.js";
import { AppError, exitCodeFor, safeError } from "./errors.js";
import { RunLedger } from "./ledger.js";
import { createNotionReader, NotionSnapshotSource } from "./notion.js";
import { businessDate, digest } from "./planner.js";
import { FileSnapshotSource } from "./source.js";
import { logicalKeyPrefix, runMorning } from "./workflow.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const commands = ["plan", "doctor", "status"];
const usage = `Usage: npm run morning:plan -- [--demo | --config targets/runtime.json] [--json] [--dry-run] [--no-record]
       npm run doctor -- [--demo | --config targets/runtime.json] [--json]
       node dist/src/cli.js status [--demo | --config targets/runtime.json] [--json]

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
No command scans job boards, changes Notion, or installs a scheduler.`;

async function main(): Promise<void> {
  let args: ReturnType<typeof parseCliArgs>;
  try { args = parseCliArgs(); } catch { throw new AppError("CONFIG", usage); }
  const {values, positionals} = args;
  if (values.help) { console.log(usage); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !commands.includes(command ?? "")) throw new AppError("CONFIG", usage);
  if (values.demo && values.config) throw new AppError("CONFIG", "Choose --demo or --config, not both.");
  if (command !== "plan" && (values["dry-run"] || values["no-record"])) {
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
  const buildSource = (config: Config) => config.source.driver === "snapshot" ? new FileSnapshotSource(config.source.path)
    : new NotionSnapshotSource(config.source, createNotionReader(config.source, process.env[config.source.tokenEnv]));

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

function renderStatusText(result: {state: string; date: string; timezone: string; latestRunDate: string | null; revision: number | null; errorCode: string | null}): string {
  const lines = [`Status: ${result.state} (today ${result.date}, ${result.timezone})`];
  if (result.latestRunDate) lines.push(`Latest recorded run: ${result.latestRunDate}${result.revision !== null ? ` (revision ${result.revision})` : ""}`);
  else lines.push("No run has been recorded for this configuration yet.");
  if (result.state === "stale") lines.push("The workflow has not completed a run for today yet.");
  if (result.errorCode) lines.push(`Last error class: ${result.errorCode}`);
  return lines.join("\n");
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
  process.exitCode = exitCodeFor(failure.code);
});
