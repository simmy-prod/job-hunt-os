# Deterministic runtime

This document describes the read-only morning planner runtime under `src/`,
run through `npm run morning:plan` and `npm run doctor`. It is separate from
the user-invoked Claude Code skills in `.claude/skills` (`job-scan`,
`interviewer-recon`, `company-deep-dive`, `interview-drill`,
`profile-interview`) and the `/morning-hunt` command that sequences them.
This runtime makes no model or API calls; it is a plain Node.js program.

## Architecture

Two Snapshot sources feed a pure planner:

- `src/source.ts` (`FileSnapshotSource`): reads a local JSON fixture. Used by
  `--demo` and by tests.
- `src/notion.ts` (`NotionSnapshotSource`): reads one Notion data source
  through a read-only transport (see "Read-only guarantees" below).

Both produce a `Snapshot` validated against `src/domain.ts`'s Zod schemas.
`src/planner.ts` turns a snapshot plus a clock and timezone into a
deterministic `Plan` (due targets, follow-ups due today, and review items for
ambiguous or malformed rows). `src/workflow.ts` wires source read, plan, and
ledger recording together and is the code path both CLI commands call through
`src/cli.ts`.

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

Both commands are read-only with respect to Notion and to any job board:
neither scans job listings, writes to Notion, submits an application, sends
a message, or installs a scheduler.

## Exit behavior

`src/cli.ts` maps a caught error's `AppError` code to a process exit code:

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `2` | Default: `CONFIG`, `SCHEMA`, `AUTH`, `INPUT`, or `POLICY` failure |
| `3` | `NOTION`: a Notion-side read or pagination failure |
| `4` | `STORAGE`: the local SQLite ledger could not be opened or written |

On any failure, the process prints a single JSON line (`{"error": <code>,
"message": <safe message>}`) to stderr. Raw provider errors, stack traces,
and any value that could contain a token or private row are never included;
`src/errors.ts`'s `safeError` collapses anything that is not already a
deliberate `AppError` into a generic, non-leaking message.

## SQLite ledger location

Every recorded run (unless `--no-record` is passed) writes to
`.runtime/runs.sqlite`, created relative to the repository root the first
time the runtime runs. `.runtime/` is gitignored and never published.
`src/ledger.ts` creates the directory at mode `0700` and the database file
at mode `0600`, refuses to follow a symlink for either, and refuses to open
a database file with more than one hard link. Each logical run key
(`morning-plan:v1:<config hash>:<Melbourne business date>`) is recorded
atomically: the `runs` table holds the latest state per key, and the
append-only `events` table holds a history of outcomes. Neither table stores
target names, URLs, tokens, notes, or raw provider error text, only status,
timestamps, a plan hash, and an `AppError` code.

## Read-only guarantees

`src/notion.ts`'s `readOnlyFetch` wraps every outbound request and rejects
anything that is not exactly one of:

- `GET /v1/data_sources/<the configured data source id>`
- `POST /v1/data_sources/<the configured data source id>/query`

Any other host, path, method, query string, credential-in-URL, or redirect
target is blocked before the request leaves the process, with a `POLICY`
error. The Notion API version is pinned (`NOTION_API_VERSION` in the same
file) so a future Notion API change cannot silently alter behavior.
Retries are bounded (at most two retries, capped at a 20-second total delay,
honoring `Retry-After`) and only apply to transient response codes.

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
| CLI silently accepts `--dry-run` but nothing changes | Known gap, tracked for the next implementation slice | No workaround today; do not rely on `--dry-run` to prevent a ledger write, use `--no-record` instead |
