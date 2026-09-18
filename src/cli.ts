import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { validate } from "./domain.js";
import { AppError, safeError } from "./errors.js";
import { createNotionReader, NotionSnapshotSource } from "./notion.js";
import { digest, planMorning } from "./planner.js";
import { FileSnapshotSource } from "./source.js";
import { runMorning } from "./workflow.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const usage = `Usage: npm run morning:plan -- [--demo | --config targets/runtime.json] [--json] [--dry-run] [--no-record]
       npm run doctor -- [--demo | --config targets/runtime.json] [--json]

Planning is always read-only for business data. Local audit/digest records are
stored privately in .runtime/runs.sqlite unless --no-record is supplied.
--demo explicitly uses fictional fixtures. It never contacts Notion.
--at <ISO timestamp with offset> injects a clock for reproducible offline checks.
Doctor validates the source and date contracts without creating local run records.
No command scans job boards, changes Notion, or installs a scheduler.`;

async function main(): Promise<void> {
  let args: ReturnType<typeof parseCliArgs>;
  try { args = parseCliArgs(); } catch { throw new AppError("CONFIG", usage); }
  const {values, positionals} = args;
  if (values.help) { console.log(usage); return; }
  if (positionals.length !== 1 || !["plan", "doctor"].includes(positionals[0] ?? "")) throw new AppError("CONFIG", usage);
  if (values.demo && values.config) throw new AppError("CONFIG", "Choose --demo or --config, not both.");
  const config: Config = values.demo ? validate(configSchema, {
    schemaVersion: 1, timezone: "Australia/Melbourne",
    source: {driver: "snapshot", path: resolve(root, "tests/fixtures/snapshot.json")},
  }, "Demo configuration") : await loadConfig(resolve(root, values.config ?? "targets/runtime.json"));
  if (values.at && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(values.at)) {
    throw new AppError("CONFIG", "--at needs an ISO timestamp with seconds and a timezone offset.");
  }
  const now = values.at ? new Date(values.at) : new Date();
  const source = () => config.source.driver === "snapshot" ? new FileSnapshotSource(config.source.path)
    : new NotionSnapshotSource(config.source, createNotionReader(config.source, process.env[config.source.tokenEnv]));
  if (positionals[0] === "doctor") {
    const snapshot = await source().read();
    const plan = planMorning(snapshot, now, config.timezone);
    const result = {status: "ok", source: config.source.driver, timezone: config.timezone,
      counts: plan.counts, warning: config.source.driver === "notion" && config.source.frequency.mode === "fixed"
        ? "Frequency is explicitly fixed by local configuration, not read from Notion." : null};
    console.log(values.json ? JSON.stringify(result, null, 2) : `Doctor: valid ${result.source} schema and records (${result.timezone}). ${result.counts.reviews} items need review.${result.warning ? ` ${result.warning}` : ""}`);
    return;
  }
  const plan = await runMorning({config, source, root, clock: {now: () => now}, record: !values["no-record"]});
  console.log(values.json ? JSON.stringify(plan, null, 2) : `${values.demo ? "Fictional demo data\n" : ""}${digest(plan)}`);
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
  process.exitCode = failure.code === "NOTION" ? 3 : failure.code === "STORAGE" ? 4 : 2;
});
