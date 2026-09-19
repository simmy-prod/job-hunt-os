# Claude to ChatGPT Handoff

## Current slice: Slice 4, safe writes (branch `feature/slice-4-safe-writes`, PR #11)

### Status

Rebased onto `origin/master` after Slices 2.0, 2.1, 2.2, and 3.0 merged, and
connected to them (retention, a named lock, manual-only enforcement against
the scheduler, the Keychain token comparison, and `status` counts). The
earlier "no scheduler or discovery on master" deviation no longer applies.

### What was implemented

- Write contract in `docs/runtime.md` ("Write contract"): allowlisted
  operations and fields, never-writable fields and operations, confirmation
  tiers, idempotency and retries, audit events, retention, failure handling,
  dry run, credential isolation, and manual-only enforcement.
- Four allowlisted operations: `target.mark_checked` (runtime-owned),
  `application.set_next_action`, `application.set_stage` (human-approved;
  cannot target `Applied`), and `application.confirm_applied` (human-approved
  plus a typed `SUBMITTED` attestation; the only path to `Applied`).
- Human approval only from an interactive terminal, with a typed per-intent
  confirmation code. Schedulers, pipes, CI, and coding agents are refused
  before storage is opened.
- Private outbox `.runtime/writes.sqlite` (schema v2): `UNIQUE` idempotency
  key, immutable approvals, value-free append-only `write_events`. Deletes
  are allowed only by retention (finished intents and approvals after 90
  days, events after 180, open intents never), enforced by triggers.
- Executor that reads back before every send (reconcile, conflict, or
  write), verifies the response, retries at most three times, and isolates
  failures per intent. `apply --execute` holds its own `.runtime/writes.lock`
  (Slice 2.1's lock, now with an optional name) and prunes at start.
- Separate write transport: only `GET` data source, `GET` page, and `PATCH`
  page whose body is exactly `{properties}` with mapped writable names.
  Refuses foreign or trashed pages and select values that would create a
  new option.
- `NOTION_WRITE_TOKEN` from the environment only (Simmy's choice: not in the
  Keychain). Refused if it matches `NOTION_TOKEN` or the Keychain read token.
- `status` gains a `writes` field: intent counts by state for the current
  config, read-only, `null` before any proposal.
- Boundary checks: forbidden Notion SDK surfaces, and `src/scheduler.ts` may
  not reach any write module through any import chain.

### Files changed

- New: `src/writes.ts`, `src/outbox.ts`, `src/notion-writer.ts`,
  `src/write-workflow.ts`, `src/storage.ts`, `tests/writes.test.ts`,
  `tests/notion-writer.test.ts`.
- Changed: `src/cli.ts` (`writes` group in master's per-subcommand option
  style, `status` counts), `src/lock.ts` (optional lock name, default
  unchanged), `src/credentials.ts` (`tryReadKeychainToken` for comparison
  only), `src/notion.ts` (shared bounded retry, exported property readers),
  `scripts/check-boundaries.mjs`, `tests/cli.test.ts`,
  `tests/privacy.test.ts`, `package.json` (`writes` script),
  `docs/runtime.md`, `README.md`, this file.
- Not changed: `src/ledger.ts` and `src/discoveryStore.ts` stay exactly as
  on master. `src/storage.ts` is used only by the outbox.

### Important decisions

- No automatic remote rollback: a compensating write would itself be
  unapproved. Uncertain outcomes are resolved by read-back.
- Intent scope uses `planningConfig`, like the run key, so editing the
  `schedule` block never orphans intents; demo intents never reach live
  Notion.
- Retention deletes are allowed by narrow triggers rather than dropping the
  triggers. Pruning appends a value-free `pruned` event first, because the
  event trigger measures age from the newest event.
- Complication found by tests: `node:sqlite` enforces foreign keys, so
  pruning defers the foreign-key check to commit
  (`PRAGMA defer_foreign_keys`) to delete an intent before its approval.
- Residual risks (documented): the terminal check stops accidental
  automation, not a deliberately faked terminal; Notion has no conditional
  update, so a one-request race remains between read-back and `PATCH`.

### Tests run

| Check | Result |
|---|---|
| `npm run check` (typecheck, lint, tests, privacy) | Pass, 219/219 |
| `npm run build:public` | Pass, only `index.html` and `data.json` |
| `git diff --check` | Pass |
| Manual `--demo` CLI run | propose, duplicate, status counts, dry run, refusals as documented |
| Live Notion write | Not run: no `NOTION_WRITE_TOKEN` yet, and a live write needs Simmy's go-ahead |

### Not implemented

- Stable external listing identity linked to Notion rows, and Markdown or
  dashboard projections. Slice 3.0 has no live provider yet, and linking a
  listing to a new application row would need page creation, which the
  policy forbids. Revisit after Slice 3.1.

### Recommended next action

Simmy reviews PR #11. Before live use: create a separate Notion write
integration (read and update content only), share it with the Target
Companies data source, export `NOTION_WRITE_TOKEN`, and run one
`target.mark_checked` end to end on a single row.

---

## Previous: Slice 2.2, macOS scheduling and recovery (branch `feature/slice-2.2-scheduler`)

### What was implemented

- `npm run schedule -- <run | status | preview | install | uninstall>`. A
  per-user LaunchAgent (`local.job-hunt-os.morning-plan`) runs
  `node dist/src/cli.js schedule run` directly: no shell, no Claude Code,
  Codex, MCP, or LLM. Triggers: `RunAtLoad`, a daily calendar time, and an
  hourly re-check.
- One logical result per business day: a scheduled trigger skips quietly if
  the day's key already succeeded, if the configured time has not arrived in
  the business timezone, or if scheduling is disabled.
- Scheduled runs reuse Slice 2.1's `.runtime/morning.lock` run lock (shared
  with manual recorded runs), covering the success check and the Notion
  read. A held lock makes a trigger report `busy` and exit 0; stale-lock
  recovery is Slice 2.1's (dead PID or 6-hour age).
- Failures are recorded (code only), retried by later triggers, and capped at
  3 scheduled attempts per day. Manual runs are never capped.
- Scheduled runs read the standalone Notion token from the macOS login
  Keychain via `/usr/bin/security` only when a run is actually due. Manual
  runs are unchanged (`NOTION_TOKEN` env, no fallback).
- Kill switch: `schedule.enabled: false` in private `targets/runtime.json`.
  A config without a `schedule` block is never scheduled.

### Files changed

- New: `src/scheduler.ts`, `src/credentials.ts`, `tests/scheduler.test.ts`,
  `tests/credentials.test.ts`.
- Changed: `src/cli.ts` (`schedule` subcommands beside `plan`, `doctor`,
  `status`), `src/config.ts` (optional `schedule` block and
  `planningConfig`, which keeps the block out of the run-key hash),
  `src/ledger.ts` (schema v2: `events.invoker`, in-place v1 migration,
  `latestStatus`, `failedAttempts`, read-only `readScheduledFailures`),
  `src/lock.ts` (read-only `inspectLock`), `src/workflow.ts` (shared
  `executeRun`, `logicalKey`), `scripts/check-boundaries.mjs`,
  `tests/cli.test.ts`, `tests/privacy.test.ts`,
  `templates/runtime-config.json`, `package.json` (`schedule` script),
  `docs/runtime.md`, `README.md`.

### Important technical decisions

1. The runtime never runs `launchctl`. `install` / `uninstall` write or remove
   one plist and print the exact command. This keeps the runtime's
   subprocess surface to a single read-only binary.
2. `node:child_process` is allowed only in `src/credentials.ts`, and the
   boundary checker enforces that every call there uses the literal
   `/usr/bin/security`. Any shell, `claude`, `codex`, alias, or other file
   fails `npm run privacy:check`.
3. An hourly `StartInterval` was added on top of `RunAtLoad` + calendar time.
   It is a no-op after the day succeeds, and it is the in-day retry path and
   the fix for a system timezone that differs from `Australia/Melbourne`.
4. No second lock. The first version of this branch predated Slices 2.0 and
   2.1 and carried its own SQLite lease; after they merged, that lease was
   removed and the scheduler now uses Slice 2.1's file lock, ledger record
   validation, and retention unchanged.
5. `logicalKeyPrefix` now hashes only the planning fields (`schemaVersion`,
   `timezone`, `source`). For a config with no `schedule` block the key is
   byte-identical to before, so existing ledger history and `status` are
   unaffected.

### Tests run and results

- `npm run check`: pass (typecheck, lint, 140 of 140 tests, merged with Slices 2.0 and 2.1, privacy check).
- `npm run build:public`: pass, `.public/` holds only `index.html` and `data.json`.
- `git diff --check`: clean.
- Scheduler tests cover duplicate triggers, simultaneous triggers, manual vs
  scheduled races, crashed-process and aged lock recovery, v1 ledger
  migration, Melbourne midnight, both DST transitions, business-timezone
  gating independent of system timezone, failure recording, retry, the
  3-attempt cap, credential and raw-error redaction, the read-only Notion
  operations, disabled scheduling, plist content, and install/uninstall in
  temporary directories only.
- Manual end to end (fictional fixture config): first run succeeded,
  duplicate was silent, three parallel triggers produced one success and two
  `busy`, a manual `plan` against a held lock exited 5 while a scheduled
  trigger reported `busy` with exit 0, a malformed source produced a redacted
  failure with exit 2, and Slice 2.1's `status` reported the scheduled
  failure. The generated plist passed `plutil -lint`. No real
  LaunchAgent was installed and the real Keychain was never written.

### Known limitations or unresolved issues

- `.runtime/logs/scheduler.log` is not rotated (Slice 2.1 retention covers
  the SQLite ledger only). It gets about one line per day, so this is low risk.
- Not yet exercised under real launchd or with the real Keychain token; that
  needs Simmy to run the setup steps in `docs/runtime.md`.
- The plist pins the absolute Node binary (a versioned Homebrew path on this
  Mac). After a Node upgrade, re-run `npm run schedule -- install`;
  `schedule status` reports `installed, out of date`.
- CI covers Node 24 and 26; locally only Node 26 was available.

### Recommended next action

Review the PR. If approved, Simmy follows "Local setup" in `docs/runtime.md`
from the main checkout and confirms one real scheduled run with
`npm run schedule -- status`.

---

## Historical: read-only morning planner foundation

## Summary

Completed and verified the read-only morning planner slice as scoped. The only
blocker named in the handoff, `no-control-regex` in `src/planner.ts`, is fixed.
The full verification suite (`npm run check`, which chains typecheck, lint,
test, privacy check) is green, `npm run build:public` produces the correct
allowlisted output, and both CLI commands work by hand with deterministic
output against both the demo fixture and the live Notion Target Companies
database. All work happened on a new branch,
`feature/deterministic-morning-planner`, per the user's global git workflow
rules; nothing was committed directly to `master` at the time of this
summary. **This is a historical snapshot of that original handoff, not the
current state**: that branch became [PR #5](https://github.com/simmy-prod/job-hunt-os/pull/5),
which has since been reviewed and merged into `master`. See "Recommended
next step" below for the current, up-to-date status.

**Update after initial handoff:** Simmy created a standalone `NOTION_TOKEN`,
shared the Target Companies data source with it directly, and built
`targets/runtime.json` (private, gitignored) from the template. `doctor` and
`morning:plan` were then run against the live database and both succeeded.
The live Notion path, previously listed below as an unresolved unknown, is
now confirmed working end to end. See the updated "Tests run" and "Known
limitations" sections.

## Files changed

- `src/planner.ts`: the only source edit. Replaced the literal control-character
  class in `oneLine` (matching U+0000 to U+001F and U+007F to U+009F) with the
  Unicode property escape `\p{Cc}` under the `u` flag. Same character set, same
  behavior, but expressed as a category escape rather than literal control
  characters, so `no-control-regex` has nothing to flag. No lint rule was
  disabled or ignored.
- Everything else in `src/`, `tests/`, `scripts/`, `templates/`,
  `.github/workflows/verify.yml`, `dashboard/sample-manifest.json`,
  `eslint.config.mjs`, `tsconfig.json`, `.nvmrc`, `package.json`,
  `package-lock.json`, `.gitignore`, `vercel.json`: unchanged from what was in
  the working tree at handoff. These were already correct.
- `CHATGPT_TO_CLAUDE_HANDOFF.md`: carried into the branch and this commit
  (it was untracked in the working tree).
- Not committed: `.deep-research/autonomous-job-hunt-os/*` (the earlier Codex
  research notes comparing Codex vs. Claude Code for this task). That is
  planning scratch, not part of the implementation, and stayed out of the
  branch.

## Important implementation decisions

1. **Branch, not `master`.** The entire foundation was sitting uncommitted on
   `master` in the main checkout. Created `feature/deterministic-morning-planner`
   from `master` before touching anything, per the user's non-negotiable git
   workflow. All verification and the fix happened on that branch.
2. **Lint fix used a property escape, not a suppression.** Chose the Unicode
   category escape over disabling the rule or narrowing scope, because it is
   semantically identical and keeps the rule fully enforced repo-wide, matching
   the handoff's "fix that without weakening lint" instruction.
3. **`docs/runtime.md` gap left alone, on the user's explicit instruction.**
   Two diagnostic messages in `src/notion.ts` and `src/domain.ts` point at
   `docs/runtime.md`, which does not exist. Raised this to the user during
   planning; they chose to leave it rather than write the doc or strip the
   reference. Recorded below as a known limitation, not fixed.
4. **`.deep-research/` excluded from the branch.** It is Codex's own planning
   output (repo audit, architecture research, a Codex-vs-Claude model
   comparison) rather than application code, tests, or docs the acceptance
   criteria call for. Left untracked rather than guessing it should ship.
5. **Live Notion verification: initially blocked, later completed by the user.**
   At handoff time no `NOTION_TOKEN` was set and no `targets/runtime.json`
   existed. Per the handoff's explicit instruction, did not substitute the
   Notion MCP connector's credential for the standalone runtime token; flagged
   this as an unresolved unknown instead. Simmy subsequently created a
   dedicated internal integration token, shared it with the Target Companies
   data source, and built `targets/runtime.json`. I verified the field mapping
   and data source ID (private; lives only in local `targets/runtime.json`,
   not reproduced here) against the live schema via a separate read-only
   Notion connection before he reran `doctor`, then he ran both `doctor` and
   `morning:plan` against the live database with the results reported back in
   chat. Both succeeded.

## Tests run and outcomes

All commands run from `/Users/ethansimmons/job-hunt-os` on the new branch.

| Command | Result |
|---|---|
| `npx tsc --noEmit` | Pass, both before and after the planner fix |
| `npx eslint src tests scripts/*.mjs eslint.config.mjs` | 1 error before fix (`no-control-regex` at `src/planner.ts:79`); 0 errors after |
| `npm test` (`tsc` then `node --test dist/tests/*.test.js`) | 61/61 pass, first time this suite has ever executed in this tree. 0 fail, 0 skipped. Covers domain validation, planner date logic, the Notion adapter (schema drift, pagination, retry, the pinned-version read-only transport, credential handling), the file/SQLite workflow (reruns, revisioning, failure isolation, symlink rejection), the CLI (demo determinism, config resolution, malformed-input handling, missing-token diagnostics), and privacy/runtime-boundary checks. |
| `npm run privacy:check` | Pass: "Privacy and runtime dependency checks passed." |
| `npm run check` (typecheck, lint, test, privacy, chained) | Pass end to end |
| `npm run build:public` | Pass. `.public/` contains exactly `index.html` and `data.json`, matching the allowlist. |
| `npm run morning:plan -- --demo --at 2026-09-18T09:00:00+10:00` | Produces the "Fictional demo data" banner, 2 due targets, 2 follow-ups, 0 reviews, all fictional example.org data. |
| Same command run twice with `--json --no-record` and identical `--at` | Byte-identical output both times, confirming determinism |
| `npm run doctor -- --demo` (text and `--json`) | Pass: reports status ok, correct counts, warning null |
| `git diff --check` | Clean, no whitespace errors |
| `npm run doctor` against live Notion (Target Companies data source) | **Pass**, run by Simmy after creating `NOTION_TOKEN` and `targets/runtime.json`: "valid notion schema and records (Australia/Melbourne). 0 items need review." Confirms schema validation, auth, and the pinned read-only transport all work against the real database, not just the mocked reader. |
| `npm run morning:plan` against live Notion | **Pass**, run by Simmy: produced a deterministic Melbourne-date digest with real due targets, follow-ups, and 0 review items. Company names and counts are private data and are intentionally omitted from this document. |

Node version used for all of the above: v26.7.0 (the only version installed;
no nvm available in this environment). `.nvmrc` pins 24, and the CI matrix
(`.github/workflows/verify.yml`) covers both 24 and 26. **Update:** GitHub CI
subsequently ran on PR #5 and passed on both Node 24 and Node 26, so
`node:sqlite` compatibility across the pinned engine range is confirmed, not
just locally exercised on 26.

## Known limitations or unresolved issues

1. ~~`docs/runtime.md` does not exist.~~ **Resolved in the mandatory-gate
   cleanup pass.** `docs/runtime.md` now exists and documents the runtime
   architecture, Node requirement, private configuration, standalone Notion
   credential requirement, explicit field mapping, fixed-weekly cadence,
   commands, exit behavior, SQLite ledger location, read-only guarantees,
   privacy boundary, and troubleshooting. `README.md` was also corrected: it
   no longer claims Node 18+, no dependencies, or the old `dashboard/` Vercel
   output directory, and now distinguishes the deterministic runtime from the
   user-invoked Claude Code skills.
2. Live Notion path: confirmed working. Simmy created `NOTION_TOKEN` and
   `targets/runtime.json`, and both `doctor` and `morning:plan` run
   successfully against the live Target Companies data source. The database
   has no `Check Frequency` property, so `targets/runtime.json` uses
   `frequency.mode: "fixed"` with `value: "weekly"` for every target rather
   than a per-row cadence. If per-company daily/weekly cadence is wanted,
   that needs either a `Check Frequency` select column added to the database
   or an explicit decision to keep the fixed default. This is now documented
   in `docs/runtime.md`.
3. ~~Node 24 untested.~~ **Resolved.** GitHub CI ran the full `npm run check`
   and `npm run build:public` suite on both Node 24 and Node 26 for PR #5 and
   passed on both. Node 24 is no longer an unresolved compatibility concern.
4. `.deep-research/` left untracked. If that research trail should be
   preserved in the repo, it needs an explicit decision and a separate commit;
   it was not folded into this slice.
5. ~~The CLI accepts `--dry-run` but the flag currently has no effect.~~
   **Resolved in Slice 2.0.** See the dedicated section below.

## Deviation from the supplied plan

None in scope or acceptance criteria. The only deviation from the literal
handoff text: it named `apply_patch` as the edit tool; this session used
Claude Code's native file-editing tools instead, functionally equivalent, same
single-line diff. The lint fix and verification sequence otherwise followed
the handoff and the approved plan exactly.

## Recommended next step

1. ~~Push `feature/deterministic-morning-planner` and open a PR into `master`
   for review.~~ Done: [PR #5](https://github.com/simmy-prod/job-hunt-os/pull/5),
   **merged into `master`.**
2. ~~Have Simmy set `NOTION_TOKEN` and create a private `targets/runtime.json`
   so `doctor` and `plan` can be run against live Notion at least once.~~ Done
   and verified live.
3. Decide whether target cadence should stay fixed-weekly for everyone or
   move to a per-row `Check Frequency` column in the Target Companies
   database, then update `targets/runtime.json`'s `frequency` block to match.
4. ~~Decide on `docs/runtime.md`: write it, or strip the two dangling
   references.~~ Done: `docs/runtime.md` now exists.
5. ~~Confirm Node 24 compatibility via the CI run on the pushed branch.~~ Done:
   CI passed on both Node 24 and Node 26.
6. ~~Merge PR #5 once reviewed.~~ Done: PR #5 is merged into `master`.
7. ~~This mandatory-gate cleanup itself...~~ Done: merged as PR #8.

---

## Slice 2.0: foundation consolidation

Branch `feature/slice-2.0-foundation-consolidation`, created fresh from
`origin/master` at `baf6e34` (the merged gate-cleanup commit). Scope per
`CHATGPT_TO_CLAUDE_HANDOFF.md`'s Slice 2.0 deliverables: resolve the
`--dry-run` no-op, add the missing workflow-run domain schema, keep
everything else read-only and unchanged.

### Summary

- `--dry-run` now has a real, tested effect: it prevents the CLI from ever
  constructing a `RunLedger`, wins over `--no-record`/`record: true` if both
  are somehow set, and visibly marks its own output (`dryRun: true` in JSON,
  a "Dry run: nothing written to the ledger" line in text) so it is
  distinguishable from a plain `--no-record` invocation in logs or scripts.
- `--dry-run` and `--no-record` are now rejected with a `CONFIG` error if
  passed to `doctor`, which never wrote to the ledger to begin with and was
  silently accepting both flags there (the same "accepted option, no effect"
  bug as `--dry-run` itself had for `plan`).
- Added `workflowRunSchema` (`src/domain.ts`): a discriminated union on
  `status` requiring exactly one of `plan` (success) or `errorCode` (failed).
  `RunLedger.record` validates every record against it before opening the
  SQLite transaction, so an ambiguous or incomplete record fails without
  touching the database. `errors.ts`'s `ErrorCode` is now backed by a zod
  enum (`errorCodeSchema`) instead of a hand-written union, as the single
  source of truth the new schema reads from.
- No scheduler, Notion write, job-board access, or business-logic change of
  any kind. `planMorning`, the Notion transport, and the config schema are
  untouched.

### Files changed

- `src/cli.ts`: `--dry-run` wired to `runMorning`'s new `dryRun` option;
  output annotated; doctor now rejects `--dry-run`/`--no-record`; usage
  string updated.
- `src/workflow.ts`: `runMorning` takes `dryRun?: boolean`; ledger
  construction is `record && !dryRun`; records now carry an explicit
  `status: "success" | "failed"` field instead of relying on
  presence-of-`plan` inference.
- `src/domain.ts`: added `isoTimestamp` and `workflowRunSchema`, exported
  `WorkflowRun` type.
- `src/errors.ts`: `ErrorCode` is now `z.infer<typeof errorCodeSchema>`.
- `src/ledger.ts`: `RunRecord` is now a discriminated union typed with the
  real `Plan`; `record()` validates against `workflowRunSchema` as its first
  statement, before `BEGIN IMMEDIATE`.
- `docs/runtime.md`: rewrote the `--dry-run` bullet, added a note on the
  workflow-run schema under "SQLite ledger location", replaced the stale
  "known gap" troubleshooting row with the new `CONFIG` error row.
- `tests/domain.test.ts`, `tests/workflow.test.ts`, `tests/cli.test.ts`: new
  cases for the schema and the dry-run/doctor-rejection behavior.
- `tests/ledger.test.ts` (new): exercises `RunLedger.record` directly with
  deliberately invalid records (both `plan` and `errorCode`; neither) via a
  type cast, and confirms the `runs`/`events` tables stay empty afterward.

### Important implementation decisions

1. **`--dry-run` and `--no-record` both suppress the ledger write; `--dry-run`
   additionally marks output.** Considered making `--dry-run` an alias for
   `--no-record` with no distinguishing behavior, but that would not give it
   a genuinely different, checkable meaning. Instead `dryRun` is threaded
   through `runMorning` as its own parameter that takes precedence over
   `record`, and the CLI marks it in the output, so a script or a human can
   tell "this run explicitly asserted no side effects" from "this run just
   happened to skip recording."
2. **The workflow-run schema treats `plan` as structurally opaque
   (`z.record(z.string(), z.unknown())`), not a full re-specification of
   `Plan`.** `Plan`'s own contents are already validated end to end by
   `planMorning`/`snapshotSchema` before a record is ever built; duplicating
   that shape in a second schema would be redundant and would drift the
   moment `Plan` changes. The new schema's job is narrower and specific to
   the bug being fixed: reject "both present" and "neither present," which a
   bare TS interface with two optional fields could not do at runtime.
3. **`errors.ts` gained a zod dependency it didn't have before.** `ErrorCode`
   was a hand-written string union; `errorCodeSchema` needed a schema, not
   just a type, so `errorCode` could be validated as part of the failure
   branch. zod is already an approved runtime dependency repo-wide, so this
   is not a new dependency, just a new import in one more file.
4. **Doctor now rejects `--dry-run`/`--no-record` instead of continuing to
   silently ignore them.** This was not explicitly named in the Slice 2.0
   deliverables list, but it is the same defect class the slice exists to
   fix ("no accepted option may be silently ignored"), it was a one-line,
   low-risk addition, and leaving it would mean the slice fixed one instance
   of the bug while leaving an identical one in place two lines away.

### Tests run and outcomes

All commands run from the worktree root on
`feature/slice-2.0-foundation-consolidation`.

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm test` | 70/70 pass (61 existing + 9 new: 1 workflow-run schema case group, 2 ledger direct-validation cases, 1 dry-run workflow case, 1 well-formed-record ledger case, 4 CLI dry-run/doctor-rejection cases) |
| `npm run privacy:check` | Pass |
| `npm run check` (chained) | Pass end to end |
| `npm run build:public` | Pass, same allowlisted `.public/index.html` + `.public/data.json` output |
| `npm run morning:plan -- --demo --json --dry-run --at 2026-09-18T09:00:00+10:00` | Exits 0, output JSON has `"dryRun": true`, `.runtime/` is never created |
| `npm run doctor -- --demo --json` | Unchanged, still passes |
| `node dist/src/cli.js doctor --demo --dry-run` and `... --no-record` | Both exit 2 with a `CONFIG` error naming the restriction |
| Plain `plan --demo --at ...` (no dry-run) after the above | Still writes `.runtime/runs.sqlite` normally, confirming the fix didn't disable recording generally |
| `git diff --check` | Clean |

Node version: same as the gate-cleanup pass; no engine or dependency change
in this slice.

### Known limitations or unresolved issues

None new. Everything named in the Slice 2.0 deliverables list is resolved
and tested. The remaining open items from the prior handoff (per-company
cadence decision, `.deep-research/` disposition) are unchanged and out of
scope here.

### Deviation from the supplied plan

None. Implemented exactly the plan reviewed and approved before coding
began (see the doctor-flag-rejection addition under "Important
implementation decisions" above, which was flagged as a small, in-spirit
extension rather than a silent scope change).

### Recommended next step

Review and merge the PR for this branch, then decide whether to proceed to
Slice 2.1 (operational readiness: `status` command, `doctor` expansion,
single-instance lock, stale-lock recovery, retention policy) per
`CHATGPT_TO_CLAUDE_HANDOFF.md`. Per the handoff's operating rule, do not
begin Slice 2.1 until this slice is explicitly approved.

---

## Slice 2.1: operational readiness

Branch `feature/slice-2.1-operational-readiness`. Started from `origin/master`
at `baf6e34` (the gate-cleanup commit); Slice 2.0 (PR #9) landed on
`origin/master` partway through this session, so the branch was rebased onto
it (`c793de1`) before continuing; conflicts were limited to `src/errors.ts`
(both slices touched `ErrorCode`) and `src/workflow.ts` (both touched
`runMorning`'s options), resolved by keeping Slice 2.0's `errorCodeSchema`/
`dryRun` behavior and layering this slice's lock/retention additions on top.
Scope per the task brief and `CHATGPT_TO_CLAUDE_HANDOFF.md`'s Slice 2.1
deliverables: make the planner observable and safe to run unattended, with
no scheduler, Notion write, job-board discovery, or new runtime dependency.

### Summary

- **`status` command** (`src/cli.ts`, reading `RunLedger.readLatest` in
  `src/ledger.ts`): reports `never_run` / `success` / `failed` / `stale` for
  the current configuration by reading only the local ledger (no source
  read, no Notion call, no lock). Never creates `.runtime` as a side effect of
  running. Output never includes business data (`plan_json`/`digest`), only
  `{state, date, timezone, latestRunDate, revision, errorCode}`.
- **`doctor` expansion** (`src/doctor.ts`, new): restructured into five
  independent checks (`node`, `runtimeDir`, `gitignore`, `config`, `source`)
  that each catch their own errors, so a broken config no longer hides
  whether Node/permissions/gitignore are fine. The report shape changed from
  `{status: "ok", ...}` to `{ok, worstCode, checks: {...}, counts, warning}`;
  the one existing test asserting the old shape was updated, nothing else
  referenced it.
- **Single-instance lock** (`src/lock.ts`, new): `acquireLock` wraps the
  complete `runMorning` body (remote read included), using an `O_EXCL`-
  created `.runtime/morning.lock` file. Engaged exactly when the ledger
  itself would be touched (`record && !dryRun`), so `--no-record`/`--dry-run`
  keep their existing zero-footprint guarantee. Stale-lock recovery: a dead
  `pid` (`ESRCH` from `process.kill(pid, 0)`) or an age over 6 hours (guards
  `pid` reuse) is deleted and acquisition retried once; otherwise a `LOCKED`
  error (new exit code `5`) is thrown rather than blocking silently. Release
  re-checks the lock's `token` before unlinking, so it can never delete a
  lock a different process has since legitimately acquired.
- **Ledger retention** (`src/ledger.ts`): `record()` now prunes `runs` rows
  older than 90 days and `events` rows older than 180 days, by `observedAt`,
  in the same transaction as the write: atomic, no new command or schedule.
- New `ErrorCode` value `"LOCKED"`; `exitCodeFor` (`src/errors.ts`) is now the
  single shared exit-code mapping used by both the top-level CLI error
  handler and `doctor`'s own (non-throwing) exit-code selection.

### Files changed

- `src/lock.ts` (new): `acquireLock`/stale-lock recovery/token-checked release.
- `src/doctor.ts` (new): `checkNodeVersion`, `checkRuntimeDir`, `checkGitignore`,
  and `runDoctorReport`, which aggregates them plus the existing source-read/
  schema-validate/plan flow.
- `src/ledger.ts`: added `RunLedger.readLatest` (read-only static, never
  creates `.runtime`/the db file) and retention pruning inside `record()`.
- `src/workflow.ts`: `runMorning` now acquires/releases the lock around its
  body; added `logicalKeyPrefix(config)` (shared by `runMorning` and `status`
  so the two never compute the prefix differently).
- `src/errors.ts`: added `"LOCKED"` to `errorCodeSchema`; added `exitCodeFor`.
- `src/cli.ts`: added the `status` command; `doctor` now builds its report via
  `runDoctorReport` and prints-then-sets-exit-code instead of throwing (the
  one deliberate deviation from the plan/status throw-once contract, so a
  diagnostic command shows everything that did and didn't pass, not just the
  first failure); `--dry-run`/`--no-record` rejection extended from
  `doctor`-only to `doctor`-or-`status`; usage string updated.
- `docs/runtime.md`: documented `status`, the expanded `doctor` checks, a new
  "Concurrency and the run lock" section, the retention policy, the `LOCKED`
  exit code, and new troubleshooting rows.
- `tests/lock.test.ts` (new): acquire/release, concurrent-acquisition
  `LOCKED`, stale recovery via a real dead `pid` (spawn-then-exit, not a
  magic number), age-based staleness, token-checked release, symlink refusal.
- `tests/doctor.test.ts` (new): each check function in isolation, plus
  `runDoctorReport` aggregation (config failure still runs the other checks;
  a source/schema failure surfaces `worstCode` without hiding `config: ok`).
- `tests/ledger.test.ts`: added retention pruning (a hand-inserted 2020 row
  is gone after the next `record()`) and `readLatest` cases (never-run
  without creating `.runtime`, prefix filtering across two different config
  hashes, symlinked-ledger refusal).
- `tests/cli.test.ts`: updated the doctor-shape assertion for the new report;
  extended the dry-run/no-record rejection loop to cover `status`; added
  `status` end-to-end cases (never-run → success → stale → failed, driven
  through real `plan`/`status` invocations against a temp config) and a
  text-mode `status` case.

### Important implementation decisions

1. **The lock does not cover `doctor`.** `doctor` was already documented as
   never touching the ledger "by design"; extending the lock to it would
   contradict that existing contract for no operational benefit, since
   nothing a scheduler runs unattended calls `doctor`. Recorded explicitly in
   `docs/runtime.md` rather than left implicit.
2. **`status` parses the business date out of the existing `logicalKey`
   string rather than adding a ledger schema column.** `morning-plan:v1:
   <hash>:<date>` already ends in an unambiguous date segment (the hash is
   hex, the date is `YYYY-MM-DD`, neither contains `:`), so `readLatest` and
   `status` split on `:` and take the last segment instead of bumping
   `PRAGMA user_version` and writing a migration for one derived field.
3. **`doctor`'s report shape changed rather than being wrapped to preserve
   the old `{status: "ok"}` field.** Doctor's JSON output has no consumer
   outside this repo's own tests (checked: no script, doc example, or other
   file parses it), so this was a clean rename rather than a compatibility
   shim for an API with no external caller.
4. **Stale-lock recovery uses both `pid` liveness and a 6-hour age cutoff,
   not just one.** `pid` liveness alone is vulnerable to `pid` reuse after a
   crash; age alone would falsely reclaim a lock from an unusually slow but
   genuinely running process. Combining them (stale if either condition
   holds) was chosen over configurability, since a single Notion-database
   read/plan/write should never legitimately approach 6 hours.
5. **Retention is unconditional inside `record()`, not a separate `--prune`
   flag or command.** The deliverables ask to "define retention," and an
   opt-in prune command would need someone to remember to run it, and the whole
   point of this slice is removing things an unattended run must not depend
   on a human remembering to do.

### Tests run and outcomes

All commands run from the worktree root on
`feature/slice-2.1-operational-readiness`, after rebasing onto Slice 2.0.

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm test` | 96/96 pass (70 existing + 26 new: 6 lock tests, 12 doctor tests, 4 ledger tests, retention plus 3 `readLatest` cases, 4 CLI `status`/rejection cases) |
| `npm run privacy:check` | Pass (confirmed `src/lock.ts`/`src/doctor.ts` use only already-allowlisted imports: `node:fs`, `node:path`, `node:crypto`, `zod`, no `node:child_process`) |
| `npm run check` (chained) | Pass end to end |
| `npm run build:public` | Pass, same allowlisted `.public/index.html` + `.public/data.json` output |
| `git diff --check` | Clean |
| Manual: `doctor --demo --json` in a scratch directory | `{"ok": true, ...}` with all five checks passing against the real repo (`.runtime`/`.gitignore` checks always run against the repository root, matching the ledger's existing root-relative behavior, not the invoking `cwd`) |
| Manual: `status --demo --json` before any run, after a `--no-record` run, and after a recorded run | `never_run` → `never_run` (unchanged, confirming `--no-record` still leaves no trace) → `success` with `revision: 1` |
| Privacy/runtime-boundary check | Ran `npm run privacy:check` explicitly (see above) and re-read `scripts/check-boundaries.mjs`'s `allowedImports` against both new source files by hand |

One local cleanup note: the manual smoke test above was run once against the
actual worktree root (not a scratch copy) before its `.runtime/` and
`.public/` output were deleted with `rm -rf` prior to committing; both are
gitignored and were never staged, but noted here for transparency since nothing
outside this session's own throwaway artifacts was touched.

Node version: same as prior slices (v26.7.0 locally; CI covers 24 and 26). No
engine or dependency change in this slice.

### Known limitations or unresolved issues

- `status` has no `npm run` script alias (only `doctor`/`morning:plan` do,
  per the existing `package.json`); it is invoked directly as
  `node dist/src/cli.js status ...`, documented as such in `docs/runtime.md`.
  Adding an `npm run status` alias is a one-line `package.json` change if
  wanted, left out here since it wasn't asked for and is easy to add later.
- The 90-day/180-day retention windows and the 6-hour lock-staleness window
  are fixed constants (`src/ledger.ts`, `src/lock.ts`), not configurable via
  `targets/runtime.json`. Nothing in the deliverables asked for
  configurability, and adding it would be scope beyond "define retention."
- Everything else named in the Slice 2.1 deliverables list (`status`,
  expanded `doctor`, single-instance lock, stale-lock recovery, retention) is
  implemented and tested. No scheduler, Notion write, or job-board access was
  added, per the continuation constraints.

### Deviation from the supplied plan

One, flagged and reasoned through during implementation rather than
discovered after the fact: `doctor`'s exit-and-output handling now
prints-then-sets-`process.exitCode` instead of throwing through the shared
`main().catch()` handler, so a partially-failing report is still fully
printed to stdout. `plan` and `status` keep the original throw-once, stderr-
only-on-failure contract. This was in the reviewed plan under "doctor
expansion," not an undocumented change.

### Recommended next step

Review and merge the PR for this branch. Slice 2.2 (macOS scheduling and
recovery) requires an Opus planning/design review per
`CHATGPT_TO_CLAUDE_HANDOFF.md`'s operating rule (credential loading via
Keychain, LaunchAgent generation) before any Sonnet implementation begins;
do not start Slice 2.2 implementation directly from this handoff.
