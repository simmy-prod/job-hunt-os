# Deterministic runtime

This document describes the read-only morning planner runtime under `src/`,
run through `npm run morning:plan` and `npm run doctor`. It is separate from
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
ambiguous or malformed rows). `src/cli.ts` wires three commands to that
core differently:

- `morning:plan` calls `src/workflow.ts`'s `runMorning`, which acquires the
  run lock (see "Concurrency and the run lock" below), reads the source,
  plans, and (unless `--dry-run` or `--no-record`) records the result to the
  SQLite ledger.
- `doctor` runs a set of independent operational checks (`src/doctor.ts`:
  Node version, the private runtime directory, gitignore coverage,
  configuration, and source/schema) and calls `planMorning` directly for the
  source/schema check. It never goes through `runMorning`, never takes the
  run lock, and never touches the ledger, by design: doctor is a read-only
  diagnostic and must not create or update a run record.
- `status` reads only the local ledger (`RunLedger.readLatest`, `src/ledger.ts`)
  for the most recent recorded run under the current configuration. It never
  reads the source, never contacts Notion, and never takes the run lock.

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
npm run morning:plan -- [--demo | --config targets/runtime.json] [--json] [--dry-run] [--no-record]
npm run doctor -- [--demo | --config targets/runtime.json] [--json]
node dist/src/cli.js status [--demo | --config targets/runtime.json] [--json]
```

(`status` has no `npm run` alias; it is small and diagnostic enough to run
directly against the compiled CLI, the same way `--help` is not scripted.)

- `--demo` uses the fixture snapshot at `tests/fixtures/snapshot.json` and
  never contacts Notion. Output is fictional, always prefixed
  "Fictional demo data" in text mode.
- `--config <path>` points at an alternate runtime config; omitted, all three
  commands default to `targets/runtime.json`.
- `--json` prints the machine-readable plan, doctor report, or status result
  instead of the text form.
- `--at <ISO timestamp with offset>` injects a fixed clock, for reproducible
  output in tests or manual checks. `status` uses it the same way `plan` and
  `doctor` do, to decide what "today" is when comparing against the ledger.
- `--no-record` skips writing to the local SQLite ledger.
- `--dry-run` also skips writing to the local SQLite ledger, and additionally
  marks the output as a dry run: the JSON result gets a top-level `dryRun:
  true` field, and the text digest is prefixed `"Dry run: nothing written to
  the ledger"`. This distinguishes an explicit, auditable dry run from a
  plain `--no-record` invocation in scripts or logs that inspect the output.
  `--dry-run` takes effect even if `--record`-equivalent behavior were passed
  by mistake elsewhere: the workflow never constructs a `RunLedger` (or takes
  the run lock) when `--dry-run` is set, regardless of `--no-record`.
- `--dry-run` and `--no-record` are only accepted with `plan`. Passing either
  to `doctor` or `status` fails with a `CONFIG` error, because neither writes
  to the ledger and accepting a flag that has no effect there would be the
  same silently-ignored-option problem the flags themselves used to have.

### `doctor`

`doctor` runs every check independently and reports all of them together,
even when one has failed, so a single broken check never hides the others.
The JSON report's shape is `{ok, worstCode, checks: {node, runtimeDir,
gitignore, config, source}, counts, warning}`:

- `node`: compares the running interpreter (`process.versions.node`) against
  `package.json`'s `engines.node` contract.
- `runtimeDir`: if `.runtime` exists, checks it is a real directory (not a
  symlink) at mode `0700`; if it does not exist yet, checks the repository
  root is writable so a future run could create it. Never creates anything.
- `gitignore`: confirms `.gitignore` has a literal line for each of
  `profile/`, `pipeline/`, `prep/`, `targets/`, `.runtime/`, and `.env`. This
  is a plain string check, not a `git check-ignore` call: `src/**/*.ts` may
  not spawn a subprocess (see "Privacy boundary" below), so this mirrors
  `scripts/check-boundaries.mjs`'s equivalent check without shelling out.
- `config`: whether the selected configuration (`--demo` or `--config`)
  loaded and validated.
- `source`: whether the configured source could be read and, for a Notion
  source, whether its schema still matches the field mapping. Reported as
  `skipped: true` when `config` itself failed, since there is nothing to read.

`report.ok` is `true` only if every check passed. `report.worstCode` names
the `AppError` code of whichever failing check is worth surfacing first
(`config`'s error, or `source`'s if config passed) and is `null` when
`ok` is `true`; the CLI process exit code is derived from it the same way a
thrown error's exit code is derived (see "Exit behavior" below).

### `status`

`status` answers "did the workflow run today, and how did it go?" without
reading the source or contacting Notion: it looks up the most recent
`runs` row whose logical key matches the current configuration's hash
(`logicalKeyPrefix` in `src/workflow.ts`) and reports one of four states:

- `never_run`: no matching row exists yet (including when `.runtime` itself
  has never been created; `status` never creates it).
- `stale`: a row exists, but its date does not match today's Melbourne
  business date. The workflow has not completed a run for today yet, whether
  or not yesterday's run succeeded.
- `success` / `failed`: a row exists for today's date, with that status.
  `failed` also reports the recorded `errorCode` (the safe `AppError` code
  only, e.g. `"NOTION"`, never a message or business data).

`status` never reports `plan_json` or `digest`; its JSON output is
`{state, date, timezone, latestRunDate, revision, errorCode}` only.

Both `doctor` and `status` are read-only with respect to Notion and to any
job board: neither scans job listings, writes to Notion, submits an
application, sends a message, or installs a scheduler.

## Exit behavior

`src/cli.ts` maps a caught error's `AppError` code to a process exit code:

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `2` | Default: `CONFIG`, `SCHEMA`, `AUTH`, `INPUT`, or `POLICY` failure |
| `3` | `NOTION`: a Notion-side read or pagination failure |
| `4` | `STORAGE`: the local SQLite ledger could not be opened or written |
| `5` | `LOCKED`: another `plan` invocation currently holds the run lock |

`src/errors.ts`'s `exitCodeFor` is the single source of this mapping; both
the top-level CLI error handler and `doctor`'s own (non-throwing) exit-code
selection call it, so the two never drift apart.

On any failure, the process prints a single JSON line (`{"error": <code>,
"message": <safe message>}`) to stderr. Raw provider errors, stack traces,
and any value that could contain a token or private row are never included;
`src/errors.ts`'s `safeError` collapses anything that is not already a
deliberate `AppError` into a generic, non-leaking message.

## Concurrency and the run lock

`src/lock.ts`'s `acquireLock` gives `runMorning` a process-wide single-
instance lock over the complete workflow, including the remote Notion read:
two overlapping `plan` invocations (a manual run racing a stray scheduled
one, say) cannot both read the source and write the ledger at once. The lock
is only engaged when a run would actually touch local state (i.e. when
`record` is true and `--dry-run` was not passed), mirroring exactly when the
ledger itself gets touched, so `--no-record`/`--dry-run` keep their existing
"no local footprint at all" guarantee. `doctor` and `status` never take the
lock; neither one writes to the ledger.

The lock is a single file, `.runtime/morning.lock`, holding `{pid, startedAt,
token}` as JSON, created with an exclusive (`O_EXCL`) open so two processes
can never both believe they hold it. If the file already exists, `acquireLock`
checks whether it is stale before giving up:

- the recorded `pid` is no longer running (`process.kill(pid, 0)` raises
  `ESRCH`), or
- the lock is older than 6 hours regardless of `pid` liveness, far longer
  than any real run against one Notion database should take, and a guard
  against the recorded `pid` having since been reused by an unrelated
  process.

A stale lock is deleted and acquisition retried once; if the retry also
fails (another process legitimately raced us), or the existing lock is not
stale, `acquireLock` throws `LOCKED` (exit code `5`) rather than silently
serializing or blocking: an unattended run should fail loudly, not wait.
Releasing a lock re-reads the file first and only removes it if its `token`
still matches the one this process wrote, so a release can never delete a
lock a different process has since legitimately acquired (for example, after
this process itself was the one recovered as stale). The same symlink and
permission checks used for `.runtime` elsewhere (`src/ledger.ts`'s
constructor) apply here too.

## SQLite ledger location

Every recorded run (unless `--dry-run` or `--no-record` is passed) writes to
`.runtime/runs.sqlite`, created relative to the repository root the first
time the runtime runs. `.runtime/` is gitignored and never published.
`src/ledger.ts` creates the directory at mode `0700` and the database file
at mode `0600`, refuses to follow a symlink for either, and refuses to open
a database file with more than one hard link. Each logical run key
(`morning-plan:v1:<config hash>:<Melbourne business date>`) is recorded
atomically across two tables, and the two tables are **not** equally
private:

Before any of that, `RunLedger.record` validates the incoming record against
`workflowRunSchema` (`src/domain.ts`): a discriminated union requiring
exactly one of a `plan` (on `status: "success"`) or an `errorCode` (on
`status: "failed"`), never both and never neither. This validation runs
before the SQLite transaction opens, so an invalid or ambiguous record fails
without touching the database at all.

- `runs` holds the latest state per logical key, including `plan_json` (the
  full serialized `Plan`) and `digest` (the rendered text digest) on a
  success. Both of these **do contain business data**: company names,
  careers URLs, role types, applications' next-action text, and source
  URLs, exactly as they appear in the target/application snapshot. This is
  intentional; it's what makes a recorded run auditable. A failure record
  stores no `plan_json`/`digest`, only the `AppError` code.
- `events` is append-only and holds only `logical_key`, `observed_at`,
  `outcome`, and `error_code` per run, never the plan or digest content.
  This table is the redacted one.

Neither table ever stores `NOTION_TOKEN`, other credentials, or raw
provider error text. But `.runtime/runs.sqlite` as a whole is private
business data, not a sanitized audit log; treat it the same as `pipeline/`
or `targets/`, never copy it into a publishable path, a handoff document,
or chat.

### Retention

Every `record()` call also prunes both tables by age, in the same
transaction as the write it rides in on, so pruning is atomic and needs no
separate command or schedule:

- `runs` rows older than **90 days** (`RUN_RETENTION_DAYS`, `src/ledger.ts`)
  are deleted. This table holds full business data (`plan_json`, `digest`),
  so it is pruned sooner.
- `events` rows older than **180 days** (`EVENT_RETENTION_DAYS`) are deleted.
  This table is already redacted (no business data, just outcome and error
  class), so it is kept longer for a coarser operational history.

The age check is relative to the run being recorded (`observedAt`), not wall
clock time, so retention stays deterministic under `--at` and in tests.
This is currently the only local operational retention policy: there is no
separate log file yet (that arrives with the LaunchAgent scheduler in a
later slice), so `.runtime/runs.sqlite` is the entire local operational
record this applies to.

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

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `AUTH` error on `morning:plan`/`doctor` | `NOTION_TOKEN` unset, empty, or the token's Notion connection is not shared with the configured data source | Create a standalone internal integration, share it with the Target Companies data source, export `NOTION_TOKEN` |
| `SCHEMA` error naming a property | The live Notion property was renamed, retyped, or removed | Update `targets/runtime.json`'s `fields` (and `frequency.property` if applicable) to match the current schema, or fix the schema |
| `CONFIG` error on startup | `targets/runtime.json` missing, not valid JSON, or fails the config schema; or `--at` is not a full ISO timestamp with offset | Recreate the config from `templates/runtime-config.json`; pass `--at` as e.g. `2026-09-18T09:00:00+10:00` |
| `NOTION` error mid-run | Transient Notion outage, network failure, or pagination did not advance | Retry later; this never leaves a stale successful plan for the same logical run key |
| `STORAGE` error | `.runtime/` is missing write permission, is a symlink, or the ledger file/journal has an unexpected link count | Fix local file permissions on `.runtime/`; do not hand-edit `.runtime/runs.sqlite` |
| `POLICY` error | The read-only transport blocked a request that did not match the one allowed GET and the one allowed POST | This indicates a code defect, not a configuration problem; do not work around it by relaxing the transport |
| `CONFIG` error naming `--dry-run`/`--no-record` on `doctor` or `status` | Those flags only apply to `plan` | Drop them; `doctor` and `status` are always read-only and never write to the ledger |
| `LOCKED` error on `plan` | Another `plan` invocation is currently running (or left a lock less than 6 hours old from a `pid` that is still alive) | Wait for the other run to finish; if you are certain nothing is actually running, check for and stop a stuck process, then remove `.runtime/morning.lock` by hand |
| `doctor` reports `runtimeDir` or `gitignore` as failed | `.runtime` is a symlink or has unexpected permissions, or `.gitignore` is missing an entry for a private path | Fix `.runtime`'s permissions/symlink status directly; add the missing line(s) to `.gitignore` |
| `doctor` reports `node` as failed | The running Node version does not meet `package.json`'s `engines.node` | Switch to a Node version matching `.nvmrc` (currently `24`) |
| `status` reports `stale` | The workflow has not completed a run for today's Melbourne business date yet, whether or not a previous day's run succeeded | Run `npm run morning:plan`; `stale` on its own is not a failure, just "hasn't happened yet today" |
