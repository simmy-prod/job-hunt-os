# Claude to ChatGPT Handoff

## Latest: Slice 2.2, macOS scheduling and recovery (branch `feature/slice-2.2-scheduler`)

### What was implemented

- `npm run schedule -- <run | status | preview | install | uninstall>`. A
  per-user LaunchAgent (`local.job-hunt-os.morning-plan`) runs
  `node dist/src/cli.js schedule run` directly: no shell, no Claude Code,
  Codex, MCP, or LLM. Triggers: `RunAtLoad`, a daily calendar time, and an
  hourly re-check.
- One logical result per business day: a scheduled trigger skips quietly if
  the day's key already succeeded, if the configured time has not arrived in
  the business timezone, or if scheduling is disabled.
- A single-run lease in the SQLite ledger (shared by manual recorded runs)
  covering the full workflow including the Notion read, with stale-lease
  recovery by dead PID or 30-minute age.
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
- Changed: `src/cli.ts`, `src/config.ts` (optional `schedule` block,
  excluded from the run-key hash), `src/ledger.ts` (schema v2: `invoker`,
  `leases`, in-place v1 migration), `src/workflow.ts` (lease around recorded
  runs), `src/errors.ts` (`LOCKED`, exit 5), `scripts/check-boundaries.mjs`,
  `tests/cli.test.ts`, `tests/privacy.test.ts`, `templates/runtime-config.json`,
  `package.json` (`schedule` script), `docs/runtime.md`, `README.md`.

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
4. The lease was pulled forward from Slice 2.1 because this slice's own
   duplicate-run acceptance criteria need it.

### Tests run and results

- `npm run check`: pass (typecheck, lint, 104 of 104 tests, privacy check).
- `npm run build:public`: pass, `.public/` holds only `index.html` and `data.json`.
- `git diff --check`: clean.
- Scheduler tests cover duplicate triggers, simultaneous triggers, manual vs
  scheduled races, crashed-process and aged lease recovery, v1 ledger
  migration, Melbourne midnight, both DST transitions, business-timezone
  gating independent of system timezone, failure recording, retry, the
  3-attempt cap, credential and raw-error redaction, the read-only Notion
  operations, disabled scheduling, plist content, and install/uninstall in
  temporary directories only.
- Manual end to end (fictional fixture config): first run succeeded,
  duplicate was silent, three parallel triggers produced one success, one
  `busy`, one `already_succeeded`, and a malformed source produced a redacted
  failure with exit 2. The generated plist passed `plutil -lint`. No real
  LaunchAgent was installed and the real Keychain was never written.

### Known limitations or unresolved issues

- Slices 2.0 and 2.1 are not merged. The general `status` command, expanded
  `doctor`, log retention, and the `--dry-run` no-op flag remain open.
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
5. The CLI accepts `--dry-run` but the flag currently has no effect (it is
   parsed and then ignored in `src/cli.ts`). Not fixed in this cleanup pass;
   it is explicitly scoped to Slice 2.0 ("no accepted option may be silently
   ignored"). Documented as a known gap in `docs/runtime.md`'s
   troubleshooting table so it isn't mistaken for a working safety flag in
   the meantime.

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
7. This mandatory-gate cleanup itself (correcting the merged-state record,
   resolving the Node 24 status, adding `docs/runtime.md`, and removing the
   private Notion data source ID from both handoff documents) is its own
   branch and PR, opened after PR #5 and PR #6. Review and merge that before
   starting Slice 2.0.
