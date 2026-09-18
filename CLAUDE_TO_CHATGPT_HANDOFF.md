# Claude to ChatGPT Handoff

## Summary

Completed and verified the read-only morning planner slice as scoped. The only
blocker named in the handoff, `no-control-regex` in `src/planner.ts`, is fixed.
The full verification suite (`npm run check`, which chains typecheck, lint,
test, privacy check) is green, `npm run build:public` produces the correct
allowlisted output, and both CLI commands work by hand with deterministic
output. All work happened on a new branch, `feature/deterministic-morning-planner`,
per the user's global git workflow rules; nothing was committed to `master`.

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
5. **No live Notion verification attempted.** No `NOTION_TOKEN` is set in this
   environment and no `targets/runtime.json` exists. Per the handoff's explicit
   instruction, did not substitute the Notion MCP connector's credential for
   the standalone runtime token. This is reported here, not silently skipped.

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

Node version used for all of the above: v26.7.0 (the only version installed;
no nvm available in this environment). `.nvmrc` pins 24, and the CI matrix
(`.github/workflows/verify.yml`) covers both 24 and 26; Node 24 has not been
exercised locally and depends on that CI run once the branch is pushed.

## Known limitations or unresolved issues

1. `docs/runtime.md` does not exist, though two error messages (in
   `src/notion.ts` and `src/domain.ts`) point users to it for the Notion
   field-mapping and validation contract. Left as-is per explicit user
   instruction. Recommend either writing that doc or removing the references
   in a follow-up.
2. Live Notion path is entirely unverified. No `NOTION_TOKEN` and no
   `targets/runtime.json` exist in this environment. The demo/fixture path is
   fully tested; the actual Notion read (schema retrieve plus paginated query
   against the configured data source) has not been exercised against the
   live API in this session, only against the mocked reader in
   `tests/notion.test.ts`.
3. Node 24 untested locally. Only Node 26.7.0 was available. `node:sqlite`
   changed between 24 and 26; the CI matrix is the only current coverage for
   the pinned engine version until someone runs it on Node 24 directly.
4. `.deep-research/` left untracked. If that research trail should be
   preserved in the repo, it needs an explicit decision and a separate commit;
   it was not folded into this slice.

## Deviation from the supplied plan

None in scope or acceptance criteria. The only deviation from the literal
handoff text: it named `apply_patch` as the edit tool; this session used
Claude Code's native file-editing tools instead, functionally equivalent, same
single-line diff. The lint fix and verification sequence otherwise followed
the handoff and the approved plan exactly.

## Recommended next step

1. Push `feature/deterministic-morning-planner` and open a PR into `master`
   for review (in progress as part of this handoff).
2. Have Simmy set `NOTION_TOKEN` and create a private `targets/runtime.json`
   (from `templates/runtime-config.json`, filled in with the real data source
   ID and field mapping) so `doctor` and `plan` can be run against live
   Notion at least once before this is trusted as operational.
3. Decide on `docs/runtime.md`: write it, or strip the two dangling
   references.
4. Confirm Node 24 compatibility via the CI run on the pushed branch before
   relying on `node:sqlite` behavior beyond what Node 26 exercised locally.
