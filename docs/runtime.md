# Deterministic runtime

This document describes the deterministic runtime under `src/`: the
read-only morning planner (`npm run morning:plan`, `npm run doctor`,
`status`, and, unattended on macOS, `npm run schedule`) and the manual,
allowlisted, human-confirmed Notion write path (`npm run writes`, see
"Write contract"). It is separate from
the user-invoked Claude Code skills in `.claude/skills` (`job-scan`,
`interviewer-recon`, `company-deep-dive`, `interview-drill`,
`profile-interview`) and the `/morning-hunt` command that sequences them.
This runtime makes no model or LLM API calls; it is a plain Node.js program.
It calls the Notion API through two separate, locked-down transports: a
read-only one for planning (see "Read-only guarantees") and a write one that
can only set a few mapped properties (see "Write contract").

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
- Write-only options (`--id`, `--date`, `--action`, `--stage`,
  `--execute`, `--confirm-submitted`) are rejected on `plan`, `doctor`,
  `status`, and `schedule`, and every `writes` subcommand rejects options it
  does not use. For `writes apply`, `--dry-run` is the default (see "Write
  contract").

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
`{state, date, timezone, latestRunDate, revision, errorCode, writes}` only.
`writes` is `null` until the first write is proposed; after that it is the
count of this configuration's intents by state (`awaitingApproval`,
`approved`, `inFlight`, `failed`, `conflict`), read from
`.runtime/writes.sqlite` without opening it for writing or creating it.
Counts only: no record ids, field names, or values.

Both `doctor` and `status` are read-only with respect to Notion and to any
job board: neither scans job listings, writes to Notion, submits an
application, or sends a message.

### `schedule`

```bash
npm run schedule -- <run | status | preview | install | uninstall> [--config targets/runtime.json]
```

`schedule run` and `schedule status` accept `--json` and `--at`; `preview`
and `install` accept only `--config`; `uninstall` accepts nothing. Any other
option (including `--demo`, `--dry-run`, `--no-record`) is rejected rather
than ignored. `install` and `uninstall` write or remove one local
LaunchAgent file and nothing else. See "Scheduling (macOS LaunchAgent)"
below.

## Exit behavior

`src/cli.ts` maps a caught error's `AppError` code to a process exit code:

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `2` | Default: `CONFIG`, `SCHEMA`, `AUTH`, `INPUT`, or `POLICY` failure |
| `3` | `NOTION`: a Notion-side read or pagination failure; or `writes apply --execute` finished with any intent failed, conflicted, or waiting to retry |
| `4` | `STORAGE`: the local SQLite ledger could not be opened or written |
| `5` | `LOCKED`: another recorded run (manual or scheduled) currently holds the run lock. A scheduled run that finds the lock held reports `busy` and exits `0` instead |

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

`acquireLock` takes an optional name. Everything above uses the default
`morning` lock. `writes apply --execute` holds a separate
`.runtime/writes.lock` with the same stale-recovery rules, so an executed
write run never blocks, or is blocked by, a morning plan. A second
concurrent `writes apply --execute` fails with `LOCKED` (exit `5`). The
write dry run takes no lock.

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
  `outcome`, `error_code`, and `invoker` (`manual` or `scheduled`) per run,
  never the plan or digest content. This table is the redacted one.

The ledger schema is version 2 (`PRAGMA user_version`). A version 1 ledger
is migrated in place on first open, under the write lock: `invoker` is added
to `events` and existing rows are marked `manual`. The scheduler uses
`invoker` to cap its own retries without counting manual failures.

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
This policy covers `.runtime/runs.sqlite` only. The scheduler's
`.runtime/logs/scheduler.log` is not rotated; see "Scheduling" for why it
stays small.

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

## Write contract

The planner above stays read-only. Notion writes exist only behind a
separate `writes` command group (`src/writes.ts` policy, `src/outbox.ts`
local outbox, `src/notion-writer.ts` transport, `src/write-workflow.ts`
executor). Nothing in `plan` or `doctor` can reach that code, and no
command writes unless an operator runs `writes apply --execute`.

### Allowlisted operations

Exactly four operations exist. Anything else is rejected with a `POLICY`
error before storage is opened or the network is touched.

| Operation | Record | Fields written | Confirmation |
|---|---|---|---|
| `target.mark_checked` | target | `lastChecked` := today's Melbourne business date | Runtime-owned: approved by policy at proposal |
| `application.set_next_action` | application | `nextAction`, `nextActionDate` | Human, interactive terminal |
| `application.set_stage` | application | `pipelineStage` := `Researching`, `Screen`, `Interview`, `Final`, `Offer`, or `Closed` | Human, interactive terminal |
| `application.confirm_applied` | application | `pipelineStage` := `Applied`, plus `appliedDate` when mapped | Human, interactive terminal, plus a typed submission attestation |

Field names are resolved through the existing explicit `fields` mapping in
`targets/runtime.json`; the runtime never writes a property it was not
told the name of.

Operation preconditions (checked at proposal and again at apply):

- `mark_checked` never moves a date backwards and never sets a future date.
- `set_stage` cannot target `Applied`. The only path to `Applied` is
  `confirm_applied`, which also requires the current stage to be
  `Researching`.
- `confirm_applied` dates cannot be in the future.
- `set_next_action` requires both a non-empty action (at most 2000
  characters, one line) and a valid date.
- A write that would set a select to an option the data source does not
  already have is refused with `SCHEMA`, so a write can never implicitly
  create a new Notion select option.

### Never writable

- Fields: `company` (title), `watchStatus`, `careersUrl`, `roleTypes`,
  `role`, `sourceUrl`, the frequency property, and every unmapped property.
- Operations: creating, archiving, trashing, restoring, moving, or
  duplicating pages; icon, cover, or content (block) changes; comments;
  database or data source schema changes; file uploads; user lookups.
- Anything outside the configured data source: the writer reads each page
  first and refuses a page whose parent is not that data source.
- Application submission, email, LinkedIn, or any other third-party
  message. No code path exists for these, and the runtime import allowlist
  and forbidden-SDK-call scan in `scripts/check-boundaries.mjs` keep it that
  way.

`src/notion-writer.ts`'s `writeFetch` enforces this at the transport,
independent of the policy code: it permits only
`GET /v1/data_sources/<configured id>`, `GET /v1/pages/<uuid>`, and
`PATCH /v1/pages/<uuid>` whose JSON body has exactly one key, `properties`,
naming only mapped writable properties. Every other host, path, method,
body key (`archived`, `in_trash`, `icon`, `cover`, ...), property name,
query string, or redirect is blocked with `POLICY` before it leaves the
process.

### Human confirmation

- Runtime-owned operations (`mark_checked`) receive a `policy` approval
  record when proposed. They still only reach Notion through
  `writes apply --execute`.
- Human-tier operations stay `awaiting_approval` until `writes approve`
  records a `human_tty` approval. `approve` refuses to run unless both
  stdin and stdout are an interactive terminal, so a scheduler, CI job,
  pipe, or coding agent cannot approve. The operator must type the intent's
  8-character confirmation code shown on screen.
- `confirm_applied` additionally requires the `--confirm-submitted` flag and
  typing `SUBMITTED`, recorded as a `submitted` attestation. Without it the
  approval is refused, and the executor re-checks the attestation
  immediately before sending. This is the only way the runtime can set
  `Applied`, and it records a human statement that the application was
  already submitted by hand; the runtime never submits anything.
- An approval binds to the intent's idempotency key. Intents are immutable
  after proposal, so an approved payload cannot change.
- `writes reject <id>` closes an intent without writing.

The terminal check stops accidental automation; it is not a defense
against someone deliberately faking a terminal on the operator's own Mac.

### Idempotency, duplicates, and retries

- Every intent has an idempotency key: SHA-256 of the canonical
  `{operation, source, record id, desired values, expected values}`. The
  outbox enforces it with a `UNIQUE` constraint, so proposing the same
  change twice returns the existing intent and records a `duplicate`
  event instead of a second row.
- Every write is a property *set*; no operation creates, appends, or
  increments, so a replayed request cannot create a duplicate record.
- Before every send, the executor re-reads the page and compares the
  intent's fields:
  - already equal to the desired values: marked `applied` as
    `reconciled`, no request sent (covers a crash after a successful send,
    a timeout whose request actually landed, and a replayed `apply`);
  - equal to the expected values captured at proposal: sent;
  - anything else: `conflict`, nothing sent. A human edit made in Notion
    after the proposal always wins. Re-propose to write over it.
- `apply --execute` holds `.runtime/writes.lock` (see "Concurrency and the
  run lock"), so two executed runs never overlap. Inside a run, each intent
  is also claimed (`in_flight`) in its own transaction before the request.
  A claim younger than ten minutes is skipped; an older one is treated as
  abandoned by a crashed run and resumed with the read-back above.
- Transient failures (`NOTION`) return the intent to `approved` with an
  attempt count; the third failed attempt makes it `failed`. `AUTH`,
  `POLICY`, and `SCHEMA` failures are terminal immediately. The transport
  retries at most twice per request, the same bounded policy as reads.

Residual risk: Notion has no conditional update, so a human edit landing
in the milliseconds between the read-back and the `PATCH` can still be
overwritten. The window is one request long, and the post-write
verification below still reports what was written.

### Audit events

`.runtime/writes.sqlite` (same private directory and file protections as
the run ledger, mode `0700`/`0600`, no symlinks or hard links) holds:

- `intents`: one row per idempotency key with operation, record id, source
  key, desired and expected values, state, attempts, and last safe error
  code. The values are private business data, like `runs.plan_json`.
- `approvals`: one row per approved intent with method (`policy` or
  `human_tty`), attestation (`submitted` or none), and timestamp.
- `write_events`: append-only, one row per `proposed`, `duplicate`,
  `approved`, `rejected`, `claimed`, `sent`, `applied`, `reconciled`,
  `conflict`, `retry`, or `failed` transition, with intent id, timestamp,
  and safe error code, plus a `pruned` row (intent id `*`) each time
  retention deletes events. It never stores field values, tokens, page
  titles, or raw provider errors.

Intents carry a source key (hash of the planning config, the same fields as
the run key, so editing the `schedule` block does not orphan them). So
fictional `--demo` proposals can never be applied against the live data
source.

#### Outbox retention

Same split as the run ledger (see "Retention"): rows that hold field values
go sooner than value-free audit rows.

- Finished intents (`applied`, `rejected`, `conflict`, `failed`) and their
  approvals are deleted 90 days after their last update. Intents that are
  awaiting approval, approved, or in flight are never deleted.
- `write_events` rows are deleted after 180 days.
- Pruning runs at the start of every `writes apply --execute`, under the
  writes lock, in one transaction. Dry runs and `status` never prune.
- Deletes remain blocked by triggers except for retention: an approval can
  be deleted only after its intent is gone, and an event only once it is
  180 days older than the newest event. Updates to approvals and events are
  always blocked.

### Failures, rollback, and dry-run

- `writes apply` is a dry run unless `--execute` is given. The dry run
  lists which intents would be sent and which properties they touch, then
  exits without reading the write credential, contacting Notion, taking a
  lock, or creating or changing any local file. It opens
  `.runtime/writes.sqlite` with `readOnly: true`; if the outbox (or
  `.runtime` itself) does not exist yet, it reports no intents and creates
  nothing. A regression test starts from an empty directory and checks that
  it is still empty afterwards.
- Each `PATCH` is one atomic Notion request containing every property for
  that intent, so a single intent cannot half-apply (for example,
  `Applied` without its date).
- After a `PATCH`, the executor parses the returned page and verifies every
  written field. An unverified response is recorded as a failure, never as
  `applied`.
- Intents in one run are independent: a failure in one is recorded and the
  rest continue. `apply` exits `0` only when nothing failed or conflicted,
  `3` if any intent failed, conflicted, or is waiting to retry, `4` on a
  local storage failure, and `5` (`LOCKED`) if another executed run holds
  the writes lock.
- There is no automatic remote rollback. A compensating write would itself
  be an unapproved write. Instead, local state never claims success before
  Notion confirms it; if the local record fails after a successful remote
  write, the intent stays `in_flight`; once its ten-minute claim expires,
  the next `apply` reconciles it by read-back without sending again.

### Credential isolation

- Writes use a second, dedicated Notion integration whose token is read
  from `NOTION_WRITE_TOKEN`, only inside `writes apply --execute`. Give it
  read content and update content capabilities, no insert content, no
  comment capabilities, and share it only with the Target Companies data
  source. `NOTION_TOKEN` stays a read-only integration.
- `NOTION_WRITE_TOKEN` is an environment variable only. It is deliberately
  not stored in the Keychain: writes are always run by hand, and nothing
  unattended should be able to reach a write credential.
- `apply --execute` refuses to run if `NOTION_WRITE_TOKEN` is missing, or
  identical to `NOTION_TOKEN` or to the Keychain read token that scheduled
  runs use (`job-hunt-os.notion` / `NOTION_TOKEN`), so one credential cannot
  silently serve both roles. A missing or locked Keychain item is not an
  error for this comparison.

### Writes are manual only

- The scheduler never writes. `schedule run` executes only the read-only
  morning plan, and `scripts/check-boundaries.mjs` fails if
  `src/scheduler.ts` reaches `src/writes.ts`, `src/outbox.ts`,
  `src/notion-writer.ts`, or `src/write-workflow.ts` through any chain of
  imports.
- Scheduled runs have no environment variables, so they could not read
  `NOTION_WRITE_TOKEN` even if a path existed.
- Approval needs an interactive terminal; `apply --execute` needs the
  operator's exported write token.
- The token is never accepted as a command argument or config value, and
  never written to SQLite, stdout, stderr, or a handoff. The Notion client
  runs with its logger disabled, and every error leaves through
  `safeError`, which withholds provider text.

### Write commands

```bash
npm run writes -- propose <operation> --id <record id> [--date YYYY-MM-DD] [--action <text>] [--stage <stage>] [--demo | --config <path>] [--json]
npm run writes -- approve <intent id> [--confirm-submitted]
npm run writes -- reject <intent id>
npm run writes -- apply [--dry-run | --execute] [--demo | --config <path>] [--json]
npm run writes -- status [--json]
```

`propose` reads the current record through the normal read-only source to
capture expected values, so it needs `NOTION_TOKEN` (or `--demo`) but never
the write token. `status` lists intents with operation, record id, state,
and field names only. Like the dry run and the top-level `status`, it opens
the outbox read-only and creates nothing when none exists. Only `propose`,
`approve`, `reject`, and `apply --execute` open the outbox for writing.

## Privacy boundary

`scripts/check-boundaries.mjs` (`npm run privacy:check`, chained into
`npm run check`) enforces, on every run:

- **Runtime imports**: `src/**/*.ts` may only import `node:crypto`,
  `node:fs`, `node:fs/promises`, `node:path`, `node:url`, `node:util`,
  `node:sqlite`, `node:readline/promises` (the interactive approval
  prompt), `@notionhq/client`, `zod`, or a relative module. No HTTP,
  socket, mail, or child-process module is importable. No dynamic
  `require`, `eval`, `Function`, or dynamic `import()` is permitted anywhere
  it scans.
- **One subprocess, one binary**: `node:child_process` is rejected
  everywhere in `src/` except `src/credentials.ts`, and there only as a
  named, unaliased `execFileSync` import whose every call passes the
  literal `/usr/bin/security` as the program. A shell, `claude`, `codex`, or
  any other binary fails the check.
- **Forbidden Notion SDK operations**: `src/**/*.ts` may not reference
  `pages.create`, `pages.move`, `pages.properties`, `dataSources.create`,
  `dataSources.update`, or a client's `blocks`, `comments`, `databases`,
  `fileUploads`, `users`, `oauth`, or `views` surfaces. The write path uses
  only `pages.retrieve`, `pages.update`, and `dataSources.retrieve`.
- **Manual-only writes**: `src/scheduler.ts` may not reach any write module
  through any chain of relative imports (`checkWriteIsolation`).
- **Publishable file set**: nothing under `profile/`, `pipeline/`, `prep/`,
  `targets/`, `.runtime/`, `.public/`, `node_modules/`, or `dist/`, and not
  `dashboard/data.local.json` or any `.env*` file, may appear in the
  tracked-or-untracked file set `git ls-files` reports.
- **Gitignore coverage**: the private directories and files above
  (including `.runtime/writes.sqlite`) must actually be git-ignored, checked with `git check-ignore`.
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
| When a trigger does work | Only when all hold: `schedule.enabled` is `true`; the business-timezone wall clock is at or after `schedule.time`; no live run holds the run lock; today's logical key has no success; and fewer than 3 scheduled attempts for today's key have failed. Otherwise it exits `0` without reading credentials or contacting Notion. |
| Idempotency | One logical key per business day: `morning-plan:v1:<planning config hash>:<business date>`. The `schedule` block is excluded from the hash, so editing it never forks a day (and `status` keeps finding the same history). After a success, every later trigger that day is a no-op. |
| Duplicate prevention | The same `.runtime/morning.lock` run lock as `plan` (see "Concurrency and the run lock"), taken before the success check and the source read and released after the result is recorded. A trigger that finds the lock held reports `busy` and exits `0` instead of failing. |
| Timezone | Business date and the `schedule.time` gate use `timezone` from the config (`Australia/Melbourne`), never the system timezone. launchd's calendar trigger follows the system clock, so if they differ the hourly re-check runs the plan within an hour of the configured business time. `schedule status` warns about a mismatch. |
| DST | The gate compares wall-clock `HH:MM`. A skipped local hour runs at the first trigger after the jump; a repeated hour cannot run twice because the day's key already succeeded. |
| Retry | Within a run: only the bounded Notion transport retries. Across runs: a failed day is retried by the next hourly or login trigger, up to 3 failed scheduled attempts per key, then scheduled runs stop for that day (`attempts_exhausted`). Manual runs are never capped. |
| Failure visibility | Each failure is recorded in the ledger (code only), exits nonzero, and appends one redacted JSON line to `.runtime/logs/scheduler.log`. `schedule status` shows today's state and error code. |
| Quiet success | A successful run appends one line of counts to the log. Skips (not due, already succeeded, disabled, exhausted) print nothing. |
| Manual runs | `morning:plan` (recorded) shares the key and the run lock. A manual success satisfies the day for the scheduler. A manual recorded run during an active scheduled run fails fast with `LOCKED` (exit `5`). `--no-record`, `--dry-run`, `doctor`, and `status` take no lock and write nothing. |
| Restart recovery | The run lock's own stale rules apply: a lock whose PID no longer exists, or older than 6 hours, is recovered by the next run. Ledger writes are transactional, so a crash leaves either the previous state or a complete new record, never a partial success. `RunAtLoad` re-checks the day after every login. |
| Credentials | Scheduled runs read the token from the login Keychain (generic password, service `job-hunt-os.notion`, account `NOTION_TOKEN`) through `/usr/bin/security`, only when a run is actually due. The token is held in memory only. It is never in the plist, program arguments, job environment, logs, SQLite, or docs. Manual runs keep using the `NOTION_TOKEN` environment variable with no Keychain fallback. |
| Log | `.runtime/logs/scheduler.log`, inside the `0700` private directory, created by launchd under umask `077`. Counts, dates, and error codes only. Not rotated: it gets about one line per successful day plus one per failed attempt, so it stays small. Delete it by hand at any time. |

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
5. Confirm: `npm run schedule -- status` (scheduler view: install state,
   today's outcome, scheduled failures, lock state) or
   `node dist/src/cli.js status` (the general latest-run view). The first time a scheduled run
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

## Discovery (job-source contracts, no live provider yet)

`src/jobSource.ts`, `src/normalize.ts`, `src/discoveryStore.ts`, and
`src/discovery.ts` define how a future job-board adapter's raw output would
be turned into normalized, deduplicated listings and match decisions. **No
live adapter exists yet** (Slice 3.1/3.2 add Greenhouse and Lever); nothing
in this section contacts a real host, writes to Notion, submits an
application, or sends a message. It is exercised entirely by fixtures
(`tests/fixtures/discovery-listings.json`) and unit tests today.

### Adapter boundary

`JobSourceAdapter` (`src/jobSource.ts`) is the only interface allowed to
reach a job board: `{sourceId, fetchPage(cursor)}`, returning one page of
untrusted raw listings plus a `nextCursor` (or `null` at the end).
`fetchAllListings` walks every page, bounded to 100 pages, and fails closed
(`SOURCE` error) on a non-advancing cursor or a budget overrun, mirroring
`src/notion.ts`'s pagination guard. Any adapter error that is not already a
specific `AppError` is collapsed to a generic `SOURCE` error so a raw
provider error never leaks into a run summary.

`readOnlyJobFetch` is the same kind of transport guard as `src/notion.ts`'s
`readOnlyFetch`: GET-only, HTTPS-only, host-allowlisted
(`APPROVED_JOB_SOURCE_HOSTS`, currently `boards-api.greenhouse.io` and
`api.lever.co`, the two hosts the roadmap's next slices target), no
credentials or fragment in the URL, no redirects, bounded retries on
transient status codes. It exists now so a future adapter cannot widen its
own reach; no code calls it yet because no adapter exists yet.

### Normalization

`normalizeListing` (`src/normalize.ts`) takes one untrusted raw listing
(already coerced by its adapter into the common shape
`{externalId, title, company, url, locations, employmentType?, compensationText?}`)
and either produces a `Listing` or a `DiscoveryReview`. It never throws on
bad input: a missing or unsafe external ID, missing title/company, a missing
or invalid URL (including one with embedded credentials), or no location
information all become a review item with an explicit reason, never a
guessed listing and never a failed run. `employmentType` and
`compensationText` are genuinely optional on the raw listing (most real
postings omit pay, and not every provider labels employment type): their
absence never blocks normalization, it is preserved as `null` on the
`Listing`, and it is `evaluateMatch`, not normalization, that decides what an
absent value means for role fit. `normalizeBatch` runs this over every raw
listing from one source's fetch and collapses repeated external IDs within
that batch into one listing, deterministically (the last occurrence in fetch
order wins), reporting the collision count as `duplicatesInBatch` rather
than silently dropping it.

A listing's identity, `${sourceId}:${externalId}`, is a pure function of the
adapter's own field values, not a counter: re-normalizing the same raw
listing on a later run always produces the same id. `contentHashOf` hashes
`title`/`company`/`canonicalUrl`/`locations` (sorted, so reordering alone
never counts as a change) plus `employmentType`/`compensationText`, so a
provider adding a salary range or relabeling employment type on the same
listing counts as changed content, not a no-op.

### Matching

`evaluateMatch` (`src/normalize.ts`) judges one normalized `Listing` against
a private matching configuration (`targets/matching.json`, gitignored, from
`templates/matching-config.json`; schema in `src/matchingConfig.ts`):
`titleIncludeKeywords`, `titleExcludeKeywords`, `allowedEmploymentTypes`
(`null` means no restriction), and `requireCompensation`, plus a
`ruleVersion` recorded on every decision. Every signal is evaluated, not
short-circuited on the first hit, with a fixed precedence:

1. Any disqualifying signal (an excluded title keyword, or a *known*
   employment type outside `allowedEmploymentTypes`) makes the decision
   `not_a_match`, regardless of anything else.
2. Otherwise, any ambiguous signal (an *unknown* employment type when
   `allowedEmploymentTypes` is set, or missing pay when
   `requireCompensation` is `true`) makes it `needs_review`. A title that
   would otherwise match is still sent to review here, never guessed.
3. Otherwise, at least one included title keyword makes it `match`.
4. Otherwise (no disqualifying, ambiguous, or included signal) it is
   `needs_review`.

The shipped template is permissive (`allowedEmploymentTypes: null`,
`requireCompensation: false`), since most real postings omit pay and not
every source labels employment type; a stricter local `targets/matching.json`
can opt into both checks. This is the only place discovery reads search
criteria; it never reads `profile/` or `pipeline/`, and no listing's content
is ever sent anywhere in this slice.

### Persistence and the review queue

`DiscoveryStore` (`src/discoveryStore.ts`) is a private local store at
`.runtime/discovery.sqlite`, built with the same safety rules as
`src/ledger.ts`'s `runs.sqlite` (real directory only, no symlink, mode
0700/0600, no multi-linked database file) but a separate file: discovery
state and morning-plan run history are independent concerns.

- `mergeListings` upserts by listing id. A changed listing updates its row
  in place (reported in `changed`) and keeps its original `firstSeenAt`; a
  new id is inserted (`added`) with `firstSeenAt == lastSeenAt`. A listing
  absent from the current run's `incoming` set (a different source, or a
  source that failed this run) is never touched, let alone deleted: an
  unavailable source must not erase what was previously discovered.
- `upsertReviews` maintains an open review queue keyed by
  `(sourceId, externalId)`, so a listing that fails to normalize the same
  way on every run stays one row, not one row per run. A review with no
  usable external ID is never persisted; there is nothing stable to key it
  by, so it is only ever visible in the run summary that observed it.
  `mergeListings` deletes a matching review row the moment that same
  `(sourceId, externalId)` normalizes cleanly, so the queue only ever holds
  currently-open problems.

`runDiscovery` (`src/discovery.ts`) runs every configured adapter
independently: one source's failure is recorded in that source's own
`SourceOutcome` (`ok`, `errorCode`, `fetched`, `duplicatesInBatch`) and never
prevents another source's listings from being fetched, normalized, merged,
or matched. Nothing in this function can mark a listing applied, write to
Notion, or send a message; it only reads adapters and writes the local
discovery store.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `AUTH` error on `morning:plan`/`doctor` | `NOTION_TOKEN` unset, empty, or the token's Notion connection is not shared with the configured data source | Create a standalone internal integration, share it with the Target Companies data source, export `NOTION_TOKEN` |
| `SCHEMA` error naming a property | The live Notion property was renamed, retyped, or removed | Update `targets/runtime.json`'s `fields` (and `frequency.property` if applicable) to match the current schema, or fix the schema |
| `CONFIG` error on startup | `targets/runtime.json` missing, not valid JSON, or fails the config schema; or `--at` is not a full ISO timestamp with offset | Recreate the config from `templates/runtime-config.json`; pass `--at` as e.g. `2026-09-18T09:00:00+10:00` |
| `NOTION` error mid-run | Transient Notion outage, network failure, or pagination did not advance | Retry later; this never leaves a stale successful plan for the same logical run key |
| `SOURCE` error on a discovery adapter | Job-source outage, network failure, or pagination did not advance | Isolated to that source's own `SourceOutcome` by `runDiscovery`; other sources and previously stored listings are unaffected |
| `STORAGE` error | `.runtime/` is missing write permission, is a symlink, or the ledger file/journal has an unexpected link count | Fix local file permissions on `.runtime/`; do not hand-edit `.runtime/runs.sqlite` |
| `POLICY` error | The read-only transport blocked a request that did not match the one allowed GET and the one allowed POST | This indicates a code defect, not a configuration problem; do not work around it by relaxing the transport |
| `CONFIG` error naming `--dry-run`/`--no-record` on `doctor` or `status` | Those flags only apply to `plan` | Drop them; `doctor` and `status` are always read-only and never write to the ledger |
| `LOCKED` error on `plan` | Another `plan` invocation is currently running (or left a lock less than 6 hours old from a `pid` that is still alive) | Wait for the other run to finish; if you are certain nothing is actually running, check for and stop a stuck process, then remove `.runtime/morning.lock` by hand |
| `schedule status` shows `failed [AUTH]` | Keychain item missing, keychain locked, or `security` was denied access | Re-add the item (see "Local setup"), log in so the keychain is unlocked, and allow access when prompted |
| `schedule status` shows `attempts_exhausted` | Three scheduled attempts failed today | Fix the cause shown by the error code, then run `npm run morning:plan` by hand; tomorrow's key starts fresh |
| `schedule status` shows `installed, out of date` | Node was upgraded, the checkout moved, or the schedule time changed | Re-run `npm run schedule -- install` and the printed `launchctl` command |
| Scheduled run fires at the wrong local hour | System timezone differs from the config timezone | Expected; the hourly re-check covers it. `schedule status` shows the warning |
| `doctor` reports `runtimeDir` or `gitignore` as failed | `.runtime` is a symlink or has unexpected permissions, or `.gitignore` is missing an entry for a private path | Fix `.runtime`'s permissions/symlink status directly; add the missing line(s) to `.gitignore` |
| `doctor` reports `node` as failed | The running Node version does not meet `package.json`'s `engines.node` | Switch to a Node version matching `.nvmrc` (currently `24`) |
| `status` reports `stale` | The workflow has not completed a run for today's Melbourne business date yet, whether or not a previous day's run succeeded | Run `npm run morning:plan`; `stale` on its own is not a failure, just "hasn't happened yet today" |
| `writes approve` fails with "interactive terminal" | Run from a scheduler, pipe, CI, or coding agent | Run it yourself in a terminal; this is intentional |
| `writes apply --execute` fails with `AUTH` naming `NOTION_WRITE_TOKEN` | Write token unset, identical to `NOTION_TOKEN`, or its integration is not shared with the data source | Create a separate write integration (read and update content only), share it with the data source, export `NOTION_WRITE_TOKEN` |
| An intent ends in `conflict` | Someone changed the field in Notion after it was proposed | Nothing to fix: the human edit was kept. Re-propose if the write is still wanted |
| `SCHEMA` error "never create select options" | The stage is not an existing option in the Notion select | Add the option in Notion by hand, or choose an existing stage |
