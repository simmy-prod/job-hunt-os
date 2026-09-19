# Deterministic runtime

This document describes the read-only morning planner runtime under `src/`,
run through `npm run morning:plan`, `npm run doctor`, and (unattended, on
macOS) `npm run schedule`. It is separate from
the user-invoked Claude Code skills in `.claude/skills` (`job-scan`,
`interviewer-recon`, `company-deep-dive`, `interview-drill`,
`profile-interview`) and the `/morning-hunt` command that sequences them.
This runtime makes no model or LLM API calls; it is a plain Node.js program.
It does call the read-only Notion API (see "Read-only guarantees" below).

## Architecture

Two Snapshot sources feed a pure planner:

- `src/source.ts` (`FileSnapshotSource`): reads a local JSON fixture. Used by
  `--demo` and by tests.
- `src/notion.ts` (`NotionSnapshotSource`): reads one Notion data source
  through a read-only transport (see "Read-only guarantees" below).

Both produce a `Snapshot` validated against `src/domain.ts`'s Zod schemas.
`src/planner.ts` turns a snapshot plus a clock and timezone into a
deterministic `Plan` (due targets, follow-ups due today, and review items for
ambiguous or malformed rows). `src/cli.ts` wires the two commands to that
core differently:

- `morning:plan` calls `src/workflow.ts`'s `runMorning`, which reads the
  source, plans, and (unless `--no-record`) records the result to the
  SQLite ledger.
- `doctor` reads the source and calls `planMorning` directly. It never goes
  through `runMorning` and never touches the ledger, by design: doctor is a
  read-only diagnostic and must not create or update a run record.
- `schedule run` calls `src/scheduler.ts`'s `runScheduled`, which decides
  whether today's plan still needs to run and, if so, goes through the same
  read, plan, and record path as `morning:plan` (see "Scheduling" below).

## Node requirement

The runtime requires **Node.js 24.15.0 or newer** (`package.json`
`engines.node`, `.nvmrc` pins `24`). This is a hard contract, not a
suggestion: the ledger (`src/ledger.ts`) uses the built-in `node:sqlite`
module, which changed between Node 24 and Node 26. GitHub Actions
(`.github/workflows/verify.yml`) runs the full `npm run check` and
`npm run build:public` suite on both Node 24 and Node 26 for every push and
pull request, and both have passed. Do not assume Node 18 or 20 will run this
runtime; earlier engines do not ship `node:sqlite`.

## Private configuration

The runtime reads its configuration from `targets/runtime.json`, which is
gitignored and must be created locally from `templates/runtime-config.json`.
It is never committed and never published. Two source modes are supported,
selected by `source.driver`:

- `"snapshot"`: a local JSON file path, validated against the same
  `Snapshot` schema as the Notion reader. Used for `--demo` and offline
  checks.
- `"notion"`: a live Notion data source, identified by `source.dataSourceId`
  (a UUID). That UUID is private operational configuration and lives only in
  the local `targets/runtime.json` file. It is never printed in CLI output,
  logs, the SQLite ledger, or any tracked document, including the two
  ChatGPT/Claude handoff files.

## Standalone Notion credential

Live Notion access requires a **dedicated** integration token in the
`NOTION_TOKEN` environment variable (`source.tokenEnv` in the config is
always the literal string `"NOTION_TOKEN"`; the schema rejects anything
else). This must be its own internal integration, created and shared with
the Target Companies data source specifically for this runtime. It must
never be the same credential as any Notion MCP connector used elsewhere in
this session or repo, and must never be pasted into chat, committed, logged,
or written into a handoff document. `src/notion.ts` refuses to run without a
non-empty token and reports a generic, actionable `AUTH` error rather than
echoing anything about the failure.

## Explicit field mapping

The runtime does not infer Notion property names or types. `config.fields`
in `targets/runtime.json` names every property it reads (`company`,
`watchStatus`, `careersUrl`, `roleTypes` plus `roleTypesType`,
`lastChecked`, `pipelineStage`, `nextAction`, `nextActionDate`, and the
optional `role`, `appliedDate`, `sourceUrl`). Before every read,
`validateNotionSchema` (`src/notion.ts`) checks the live data source's
property list against this mapping and against the expected Notion property
*type* for each one (`requiredProperties` in the same file). Any mismatch
(a renamed column, a changed property type, a missing property) fails fast
with a `SCHEMA` error that names the mismatch and points here, before any
row is read. Update `targets/runtime.json`'s `fields` block to match a
schema change; the runtime will not guess.

## Fixed-weekly cadence

The live Target Companies data source currently has no `Check Frequency`
property. `targets/runtime.json` therefore uses:

```json
"frequency": { "mode": "fixed", "value": "weekly" }
```

which applies the same weekly cadence to every target regardless of row
content. The config schema also supports `"mode": "property"` (read a named
select column per row, falling back to `emptyDefault` when a row's value is
blank) for a future per-company cadence, but that mode is not active against
the live database today. `doctor` reports which mode is active and, when
`"fixed"` is used against a live Notion source, prints an explicit warning
that frequency is not being read from Notion.

## Commands

```bash
npm run morning:plan -- [--demo | --config targets/runtime.json] [--json] [--no-record]
npm run doctor -- [--demo | --config targets/runtime.json] [--json]
```

- `--demo` uses the fixture snapshot at `tests/fixtures/snapshot.json` and
  never contacts Notion. Output is fictional, always prefixed
  "Fictional demo data" in text mode.
- `--config <path>` points at an alternate runtime config; omitted, both
  commands default to `targets/runtime.json`.
- `--json` prints the machine-readable plan or doctor result instead of the
  text digest.
- `--at <ISO timestamp with offset>` injects a fixed clock, for reproducible
  output in tests or manual checks.
- `--no-record` skips writing to the local SQLite ledger. `doctor` never
  writes to the ledger regardless of this flag.
- `--dry-run` is accepted by the CLI parser but has no current effect;
  resolving that (so no accepted flag is silently ignored) is scoped to the
  next implementation slice, not this runtime baseline.

```bash
npm run schedule -- <run | status | preview | install | uninstall> [--config targets/runtime.json]
```

`schedule run` accepts `--json` and `--at`; `schedule status` accepts
`--json` and `--at`; `preview` and `install` accept only `--config`;
`uninstall` accepts nothing. Any other option is rejected rather than
ignored. See "Scheduling" below.

Every command is read-only with respect to Notion and to any job board:
none scans job listings, writes to Notion, submits an application, or sends
a message. `schedule install` and `schedule uninstall` write or remove one
local LaunchAgent file and nothing else.

## Exit behavior

`src/cli.ts` maps a caught error's `AppError` code to a process exit code:

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `2` | Default: `CONFIG`, `SCHEMA`, `AUTH`, `INPUT`, or `POLICY` failure |
| `3` | `NOTION`: a Notion-side read or pagination failure |
| `4` | `STORAGE`: the local SQLite ledger could not be opened or written |
| `5` | `LOCKED`: another recorded run holds the run lease (manual `morning:plan` only; a scheduled run reports `busy` and exits `0`) |

On any failure, the process prints a single JSON line (`{"error": <code>,
"message": <safe message>}`) to stderr. Raw provider errors, stack traces,
and any value that could contain a token or private row are never included;
`src/errors.ts`'s `safeError` collapses anything that is not already a
deliberate `AppError` into a generic, non-leaking message.

## SQLite ledger location

Every recorded run (unless `--no-record` is passed), manual or scheduled, writes to
`.runtime/runs.sqlite`, created relative to the repository root the first
time the runtime runs. `.runtime/` is gitignored and never published.
`src/ledger.ts` creates the directory at mode `0700` and the database file
at mode `0600`, refuses to follow a symlink for either, and refuses to open
a database file with more than one hard link. Each logical run key
(`morning-plan:v1:<config hash>:<Melbourne business date>`) is recorded
atomically across two tables, and the two tables are **not** equally
private:

- `runs` holds the latest state per logical key, including `plan_json` (the
  full serialized `Plan`) and `digest` (the rendered text digest) on a
  success. Both of these **do contain business data**: company names,
  careers URLs, role types, applications' next-action text, and source
  URLs, exactly as they appear in the target/application snapshot. This is
  intentional; it's what makes a recorded run auditable. A failure record
  stores no `plan_json`/`digest`, only the `AppError` code.
- `events` is append-only and holds only `logical_key`, `observed_at`,
  `outcome`, `error_code`, and `invoker` (`manual` or `scheduled`) per run,
  never the plan or digest content. This table is the redacted one.
- `leases` holds at most one row: the single-run lease (owner id, PID,
  acquisition time). It never holds business data.

The ledger schema is version 2 (`PRAGMA user_version`). A version 1 ledger
from before scheduling is migrated in place on first open: `invoker` is
added to `events` and existing rows are marked `manual`, and `leases` is
created. Older runtime code refuses a version 2 ledger rather than guessing.

Neither table ever stores `NOTION_TOKEN`, other credentials, or raw
provider error text. But `.runtime/runs.sqlite` as a whole is private
business data, not a sanitized audit log; treat it the same as `pipeline/`
or `targets/`, never copy it into a publishable path, a handoff document,
or chat.

## Read-only guarantees

`src/notion.ts`'s `readOnlyFetch` wraps every outbound request and rejects
anything that is not exactly one of:

- `GET /v1/data_sources/<the configured data source id>`
- `POST /v1/data_sources/<the configured data source id>/query`

Any other host, path, method, query string, credential-in-URL, or redirect
target is blocked before the request leaves the process, with a `POLICY`
error. The Notion API version is pinned (`NOTION_API_VERSION` in the same
file) so a future Notion API change cannot silently alter behavior.
Retries are bounded: at most two retries, only for transient response codes
(429, 500, 502, 503, 504, 529). Each individual retry's delay is capped at
20 seconds (honoring `Retry-After` when present, otherwise exponential
backoff from 500ms); if the required delay for a given attempt exceeds that
20-second cap, no retry happens for that attempt and the response is
returned as-is. The cap applies per attempt, not as a total budget across
both retries.

## Privacy boundary

`scripts/check-boundaries.mjs` (`npm run privacy:check`, chained into
`npm run check`) enforces, on every run:

- **Runtime imports**: `src/**/*.ts` may only import `node:crypto`,
  `node:fs`, `node:fs/promises`, `node:path`, `node:url`, `node:util`,
  `node:sqlite`, `@notionhq/client`, `zod`, or a relative module. No dynamic
  `require`, `eval`, `Function`, or dynamic `import()` is permitted anywhere
  it scans.
- **One subprocess, one binary**: `node:child_process` is rejected
  everywhere in `src/` except `src/credentials.ts`, and there only as a
  named, unaliased `execFileSync` import whose every call passes the
  literal `/usr/bin/security` as the program. A shell, `claude`, `codex`, or
  any other binary fails the check.
- **Publishable file set**: nothing under `profile/`, `pipeline/`, `prep/`,
  `targets/`, `.runtime/`, `.public/`, `node_modules/`, or `dist/`, and not
  `dashboard/data.local.json` or any `.env*` file, may appear in the
  tracked-or-untracked file set `git ls-files` reports.
- **Gitignore coverage**: the private directories and files above must
  actually be git-ignored, checked with `git check-ignore`.
- **Dependency allowlist**: `package.json`'s `dependencies` may only be
  `zod` and `@notionhq/client`.
- **Credential scanning**: every tracked or publishable `.ts`, `.mjs`,
  `.json`, `.md`, or `.yml` file (excluding this worktree's own
  `.claude/worktrees/` tree) is scanned for Notion internal-integration
  token and Anthropic/OpenAI-shaped API key patterns.
- **Public sample integrity**: `dashboard/data.json`'s SHA-256 must match
  `dashboard/sample-manifest.json`, and every `source_url` in it must point
  at an `example.com`/`example.org`/`jobs.example.org` host, so the public
  Vercel deploy can never accidentally ship a real record.

`npm run build:public` (Vercel's `buildCommand`, output `.public`) re-runs
the public-sample check and then copies only `dashboard/index.html` and
`dashboard/data.json` into `.public/`; it refuses to run if either target
path is a symlink or has more than one hard link, and refuses if `.public/`
already contains an unexpected file.

## Scheduling (macOS LaunchAgent)

The scheduler runs the same deterministic planner unattended on the user's
Mac. launchd starts `node dist/src/cli.js schedule run` directly: no shell,
no shell startup files, no Claude Code, Codex, MCP, or model call. It never
writes to Notion, never touches a job board, and never submits or sends
anything.

### Operational contract

| Topic | Contract |
|---|---|
| Owner | One per-user LaunchAgent, label `local.job-hunt-os.morning-plan`, at `~/Library/LaunchAgents/local.job-hunt-os.morning-plan.plist`. The runtime writes and removes only that file. It never runs `launchctl`; install and uninstall print the exact command instead. |
| Triggers | `RunAtLoad` (login, reboot, or load), `StartCalendarInterval` at `schedule.time`, and `StartInterval` every 3600 seconds. Each trigger is one `schedule run`. |
| When a trigger does work | Only when all hold: `schedule.enabled` is `true`; the business-timezone wall clock is at or after `schedule.time`; no live run holds the lease; today's logical key has no success; and fewer than 3 scheduled attempts for today's key have failed. Otherwise it exits `0` without reading credentials or contacting Notion. |
| Idempotency | One logical key per business day: `morning-plan:v1:<planning config hash>:<business date>`. The `schedule` block is excluded from the hash, so editing it never forks a day. After a success, every later trigger that day is a no-op. |
| Duplicate prevention | A single-run lease in the ledger, taken with `BEGIN IMMEDIATE` before the source read and released after the result is recorded. Concurrent triggers see `busy`. |
| Timezone | Business date and the `schedule.time` gate use `timezone` from the config (`Australia/Melbourne`), never the system timezone. launchd's calendar trigger follows the system clock, so if they differ the hourly re-check runs the plan within an hour of the configured business time. `schedule status` warns about a mismatch. |
| DST | The gate compares wall-clock `HH:MM`. A skipped local hour runs at the first trigger after the jump; a repeated hour cannot run twice because the day's key already succeeded. |
| Retry | Within a run: only the bounded Notion transport retries. Across runs: a failed day is retried by the next hourly or login trigger, up to 3 failed scheduled attempts per key, then scheduled runs stop for that day (`attempts_exhausted`). Manual runs are never capped. |
| Failure visibility | Each failure is recorded in the ledger (code only), exits nonzero, and appends one redacted JSON line to `.runtime/logs/scheduler.log`. `schedule status` shows today's state and error code. |
| Quiet success | A successful run appends one line of counts to the log. Skips (not due, already succeeded, disabled, exhausted) print nothing. |
| Manual runs | `morning:plan` (recorded) shares the key and the lease. A manual success satisfies the day for the scheduler. A manual recorded run during an active scheduled run fails fast with `LOCKED` (exit `5`). `--no-record` and `doctor` take no lease and write nothing. |
| Restart recovery | A lease is stale when its PID no longer exists or it is older than 30 minutes; the next run takes it over. Ledger writes are transactional, so a crash leaves either the previous state or a complete new record, never a partial success. `RunAtLoad` re-checks the day after every login. |
| Credentials | Scheduled runs read the token from the login Keychain (generic password, service `job-hunt-os.notion`, account `NOTION_TOKEN`) through `/usr/bin/security`, only when a run is actually due. The token is held in memory only. It is never in the plist, program arguments, job environment, logs, SQLite, or docs. Manual runs keep using the `NOTION_TOKEN` environment variable with no Keychain fallback. |
| Log | `.runtime/logs/scheduler.log`, inside the `0700` private directory, created by launchd under umask `077`. Counts, dates, and error codes only. No rotation yet; at one line per day it stays small. |

### Local setup

Run these from the main checkout (not a temporary worktree), because the
plist records absolute paths to this checkout.

1. Add `"schedule": {"enabled": true, "time": "08:00"}` to private
   `targets/runtime.json`. `time` is 24-hour `HH:MM` in the config's
   `timezone`. A config without this block is never scheduled.
2. Store the standalone Notion token in the login Keychain. Put `-w` last
   with no value so `security` prompts for it; the token then never appears
   in program arguments or shell history:

   ```bash
   security add-generic-password -s job-hunt-os.notion -a NOTION_TOKEN -w
   ```

3. Preview the plist and check its paths: `npm run schedule -- preview`
4. Install it: `npm run schedule -- install`. This compiles, writes the
   plist, creates `.runtime/logs/`, and prints the `launchctl bootstrap`
   command. Run that command to start now, or log out and back in.
5. Confirm: `npm run schedule -- status`. The first time a scheduled run
   reads the Keychain, macOS may ask whether `security` may access the item;
   choose "Always Allow" so unattended runs work.

Re-run `npm run schedule -- install` after upgrading Node or moving the
checkout: the plist pins the absolute Node binary, and `schedule status`
reports `installed, out of date` when it no longer matches.

### Disabling safely

- **Pause (kill switch):** set `"enabled": false` in `targets/runtime.json`'s
  `schedule` block. The next trigger exits `0` before opening the ledger or
  reading the Keychain. No launchd change is needed, and manual runs are
  unaffected.
- **Remove:** `npm run schedule -- uninstall` deletes only this runtime's
  plist (it refuses a symlink or a file with another label), then prints
  `launchctl bootout gui/<uid>/local.job-hunt-os.morning-plan` to unload the
  running job. Optionally delete the Keychain item with
  `security delete-generic-password -s job-hunt-os.notion -a NOTION_TOKEN`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `AUTH` error on `morning:plan`/`doctor` | `NOTION_TOKEN` unset, empty, or the token's Notion connection is not shared with the configured data source | Create a standalone internal integration, share it with the Target Companies data source, export `NOTION_TOKEN` |
| `SCHEMA` error naming a property | The live Notion property was renamed, retyped, or removed | Update `targets/runtime.json`'s `fields` (and `frequency.property` if applicable) to match the current schema, or fix the schema |
| `CONFIG` error on startup | `targets/runtime.json` missing, not valid JSON, or fails the config schema; or `--at` is not a full ISO timestamp with offset | Recreate the config from `templates/runtime-config.json`; pass `--at` as e.g. `2026-09-18T09:00:00+10:00` |
| `NOTION` error mid-run | Transient Notion outage, network failure, or pagination did not advance | Retry later; this never leaves a stale successful plan for the same logical run key |
| `STORAGE` error | `.runtime/` is missing write permission, is a symlink, or the ledger file/journal has an unexpected link count | Fix local file permissions on `.runtime/`; do not hand-edit `.runtime/runs.sqlite` |
| `POLICY` error | The read-only transport blocked a request that did not match the one allowed GET and the one allowed POST | This indicates a code defect, not a configuration problem; do not work around it by relaxing the transport |
| `LOCKED` (exit `5`) on `morning:plan` | A scheduled or other recorded run is in progress | Wait for it to finish and retry; use `--no-record` for a lock-free read |
| `schedule status` shows `failed [AUTH]` | Keychain item missing, keychain locked, or `security` was denied access | Re-add the item (see "Local setup"), log in so the keychain is unlocked, and allow access when prompted |
| `schedule status` shows `attempts_exhausted` | Three scheduled attempts failed today | Fix the cause shown by the error code, then run `npm run morning:plan` by hand; tomorrow's key starts fresh |
| `schedule status` shows `installed, out of date` | Node was upgraded, the checkout moved, or the schedule time changed | Re-run `npm run schedule -- install` and the printed `launchctl` command |
| Scheduled run fires at the wrong local hour | System timezone differs from the config timezone | Expected; the hourly re-check covers it. `schedule status` shows the warning |
| CLI silently accepts `--dry-run` but nothing changes | Known gap, tracked for the next implementation slice | No workaround today; do not rely on `--dry-run` to prevent a ledger write, use `--no-record` instead |
