# Claude to ChatGPT Handoff

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
it (`c793de1`) before continuing — conflicts were limited to `src/errors.ts`
(both slices touched `ErrorCode`) and `src/workflow.ts` (both touched
`runMorning`'s options), resolved by keeping Slice 2.0's `errorCodeSchema`/
`dryRun` behavior and layering this slice's lock/retention additions on top.
Scope per the task brief and `CHATGPT_TO_CLAUDE_HANDOFF.md`'s Slice 2.1
deliverables: make the planner observable and safe to run unattended, with
no scheduler, Notion write, job-board discovery, or new runtime dependency.

### Summary

- **`status` command** (`src/cli.ts`, reading `RunLedger.readLatest` in
  `src/ledger.ts`): reports `never_run` / `success` / `failed` / `stale` for
  the current configuration by reading only the local ledger — no source
  read, no Notion call, no lock. Never creates `.runtime` as a side effect of
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
  in the same transaction as the write — atomic, no new command or schedule.
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
   opt-in prune command would need someone to remember to run it — the whole
   point of this slice is removing things an unattended run must not depend
   on a human remembering to do.

### Tests run and outcomes

All commands run from the worktree root on
`feature/slice-2.1-operational-readiness`, after rebasing onto Slice 2.0.

| Command | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm test` | 96/96 pass (70 existing + 26 new: 6 lock tests, 12 doctor tests, 4 ledger tests — retention plus 3 `readLatest` cases, 4 CLI `status`/rejection cases) |
| `npm run privacy:check` | Pass — confirmed `src/lock.ts`/`src/doctor.ts` use only already-allowlisted imports (`node:fs`, `node:path`, `node:crypto`, `zod`), no `node:child_process` |
| `npm run check` (chained) | Pass end to end |
| `npm run build:public` | Pass, same allowlisted `.public/index.html` + `.public/data.json` output |
| `git diff --check` | Clean |
| Manual: `doctor --demo --json` in a scratch directory | `{"ok": true, ...}` with all five checks passing against the real repo (`.runtime`/`.gitignore` checks always run against the repository root, matching the ledger's existing root-relative behavior, not the invoking `cwd`) |
| Manual: `status --demo --json` before any run, after a `--no-record` run, and after a recorded run | `never_run` → `never_run` (unchanged, confirming `--no-record` still leaves no trace) → `success` with `revision: 1` |
| Privacy/runtime-boundary check | Ran `npm run privacy:check` explicitly (see above) and re-read `scripts/check-boundaries.mjs`'s `allowedImports` against both new source files by hand |

One local cleanup note: the manual smoke test above was run once against the
actual worktree root (not a scratch copy) before its `.runtime/` and
`.public/` output were deleted with `rm -rf` prior to committing — both are
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
