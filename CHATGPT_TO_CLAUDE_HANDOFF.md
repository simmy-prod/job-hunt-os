# ChatGPT to Claude Code Handoff

> Current continuation instruction, updated 2026-09-18: the continuation sections below supersede the old implementation scope for all new work. The original handoff is retained afterward as historical context for the completed read-only foundation.

## Current verified state

- PR #5, `Add deterministic read-only morning planner runtime`, is merged into `master`.
- PR #6, the fictional public sample checksum correction, is also merged.
- GitHub verification passed on Node 24 and Node 26. Node 24 compatibility is no longer an unresolved concern.
- Vercel verification passed.
- Local verification currently passes:
  - `npm run check`
  - 61 of 61 tests
  - type checking
  - linting
  - privacy and runtime boundary checks
  - `npm run build:public`
  - `git diff --check`
- The public build contains only `.public/index.html` and `.public/data.json`.
- A standalone `NOTION_TOKEN` and private `targets/runtime.json` are configured locally.
- `npm run doctor` and `npm run morning:plan` have both succeeded against the live Notion Target Companies data source.
- The live database has no `Check Frequency` property. Private runtime configuration therefore uses an explicit fixed weekly cadence for all targets.
- No Notion writes, scheduler, notifications, job-board discovery, application submission, or third-party messaging have been implemented.
- The existing local checkout may still be on `feature/deterministic-morning-planner` and behind `origin/master`. Do not continue implementation on that branch. Refresh from current `origin/master` and create a fresh branch.

## Mandatory gate before any new implementation slice

Before continuing Slice 2.0 or any later implementation slice, finalise all four stale or incomplete points below in one focused cleanup branch and pull request. Do not begin scheduler, discovery, notification, or write work until all four points are complete and verified.

### 1. Correct the merged-state record

- Update `CLAUDE_TO_CHATGPT_HANDOFF.md` so it no longer presents PR #5 or merging as pending.
- Record that PR #5 is merged into `master`.
- Remove obsolete instructions asking Simmy to merge PR #5.

### 2. Resolve the Node 24 status

- Update `CLAUDE_TO_CHATGPT_HANDOFF.md` to record that GitHub CI passed on Node 24 and Node 26.
- Do not continue presenting Node 24 as an unresolved compatibility concern.
- Preserve the Node 24.15.0 or newer engine contract unless a separate migration is justified by repository evidence.

### 3. Create the missing runtime documentation

- Create `docs/runtime.md`, because current validation and schema-drift errors direct operators to that file.
- Document the runtime architecture, Node requirement, private configuration, standalone Notion credential requirement, explicit field mapping, fixed-weekly cadence, commands, exit behavior, SQLite location, read-only guarantees, privacy boundary, and troubleshooting.
- Update `README.md` so it no longer claims Node 18, no dependencies, the old Vercel output directory, or Claude Code as the required daily runtime for the deterministic planner.
- Preserve the distinction between the deterministic runtime and the remaining user-invoked Claude skills.

### 4. Remove private operational identifiers from public handoffs

- Remove the real Notion data-source UUID from both handoff documents. State only that the value lives in private `targets/runtime.json`.
- Do not print or copy `NOTION_TOKEN`, real company records, private URLs, contacts, or other local identifiers.
- Decide whether handoff files remain tracked coordination artifacts or become local ignored artifacts. If they remain tracked, keep them fully sanitized.

### Mandatory gate acceptance criteria

- Work starts from current `origin/master` on a fresh branch.
- All four points are completed in one focused cleanup pull request.
- `npm run check`, `npm run build:public`, and `git diff --check` pass.
- The publishable file set contains no real Notion identifier or private runtime value.
- The handoff back to ChatGPT states exactly how each point was resolved.

## Implementation assignment

I agree with giving Claude the implementation work, but one slice per branch and PR. Use Sonnet at high effort for Slice 2.0. Reserve Opus for reviewing the scheduler and credential design, where mistakes have a higher operational cost. Do not give Claude the entire roadmap as one implementation request.

Apply the same operating rule afterward:

- Sonnet at high effort implements bounded, approved slices.
- Opus plans or reviews security-sensitive work such as credential loading, scheduler recovery, concurrency, and safe remote writes.
- Finish verification and review before beginning another slice.
- Update `CLAUDE_TO_CHATGPT_HANDOFF.md` after each completed slice.
- Do not begin the following slice unless Simmy explicitly approves it after reviewing the completed handoff.

## Recommended implementation slices

### Prerequisite cleanup: finalise the four stale points

Goal: establish an accurate, sanitized, operator-usable baseline.

Scope is limited to the mandatory gate above. This cleanup receives its own branch and pull request and must finish before Slice 2.0.

Recommended implementation model: Sonnet at high effort.

### Slice 2.0: foundation consolidation

Recommended implementation model: Sonnet at high effort.

Goal: make the current read-only foundation truthful and internally complete without adding scheduling or discovery.

Deliverables:

- Resolve or remove the accepted no-op `--dry-run` CLI flag. No accepted option may be silently ignored.
- Add the missing workflow-run domain schema.
- Validate ledger record inputs so success and failure records cannot be ambiguous.
- Reconcile the README and operating instructions with the deterministic runtime while preserving user-invoked interview and preparation skills.
- Document fixed-weekly cadence as the current explicit policy.
- Keep all business operations read-only.

Acceptance criteria:

- Invalid or ambiguous run records fail before touching SQLite.
- CLI help accurately describes every accepted option.
- No CLI option is silently ignored.
- Existing live Notion planning behavior remains unchanged.
- Existing checks pass and targeted tests cover the new validation.

### Slice 2.1: operational readiness

Recommended implementation model: Sonnet at high effort. Request Opus review if the locking design materially changes runtime architecture.

Goal: make the planner observable and safe to run unattended before installing a scheduler.

Deliverables:

- Add a read-only `status` command reporting latest success or failure, timestamp, logical date, revision, and safe error class without exposing private target details.
- Expand `doctor` to verify Node version, configuration, timezone, private runtime directory, permissions, gitignore coverage, Notion access, and schema.
- Add a process-wide single-instance lock covering the complete workflow, including the remote read.
- Define and test stale-lock recovery.
- Define retention for ledger events and local operational logs.

Acceptance criteria:

- Overlapping invocations cannot run the same workflow concurrently.
- A stale lock can be recovered without deleting unrelated files.
- `status` distinguishes never-run, successful, failed, and stale states.
- Diagnostics remain redacted.
- No scheduler is installed in this slice.

### Slice 2.2: macOS scheduling and recovery

Required planning or design review model: Opus.

Recommended implementation model after plan approval: Sonnet at high effort.

Goal: run the proven read-only planner automatically on the user's Mac without an interactive shell or coding agent.

Deliverables:

- Add LaunchAgent template generation with absolute validated paths.
- Add explicit install, uninstall, status, and preview commands.
- Use `RunAtLoad` plus a daily calendar trigger so missed runs recover on the next login or launch.
- Design and implement macOS Keychain-backed retrieval for the standalone Notion credential.
- Never store the token in the repository, plist, logs, command arguments, or handoff files.
- Keep unchanged successful scheduled runs quiet.

Acceptance criteria:

- Installation is explicit and reversible.
- Tests write scheduler artifacts only to temporary directories and never install a real LaunchAgent.
- Multiple triggers produce at most one active workflow and one logical daily result.
- The job works without shell startup files or an interactive Claude or Codex session.
- Missing credentials, schema drift, and network failure remain visible and non-destructive.

### Slice 3.0: discovery contracts without a live provider

Required planning model: Opus.

Recommended implementation model after plan approval: Sonnet at high effort.

Goal: define deterministic discovery behavior before contacting job providers.

Deliverables:

- Add private, machine-readable matching configuration for the current Business Analyst, Administration/Coordinator, and adjacent non-coding search.
- Add normalized listing persistence, stable provider identity, content hashes, match decisions, rule versions, and a review queue.
- Add a central read-only HTTP transport policy for approved job-source hosts.
- Add deterministic fixtures covering title inclusion, coding-role exclusion, location, employment type, missing pay, ambiguity, duplicates, and changed content.
- Keep profile and resume data out of discovery requests.

Acceptance criteria:

- Decisions contain explicit reasons and a rule version.
- Ambiguous listings become review items rather than guessed matches.
- Changed content updates one listing identity instead of creating a duplicate.
- No live source request or business write occurs in this slice.

### Slice 3.1: Greenhouse read-only adapter

Recommended implementation model: Sonnet at high effort.

Goal: prove one public ATS adapter end to end before adding another provider.

Deliverables:

- Add a Greenhouse adapter using documented public read endpoints only.
- Normalize listings through the Slice 3.0 contracts.
- Add bounded retries, source health, deduplication, fixtures, and mocked transport integration tests.
- Stage strong matches and ambiguous items in the local review queue only.

Acceptance criteria:

- Provider fixtures normalize deterministically.
- Mutation methods and unapproved hosts are blocked.
- One source failure cannot corrupt prior successful state.
- No application form, Notion write, or third-party message is possible.

### Slice 3.2: Lever adapter and degraded-source reporting

Recommended implementation model: Sonnet at high effort.

Goal: add a second provider without weakening provider isolation.

Deliverables:

- Add the Lever adapter through the existing contracts and transport policy.
- Run provider steps independently and record degraded partial success.
- Surface provider health and review counts through `status` and the morning digest.

Acceptance criteria:

- Greenhouse and Lever failures are isolated.
- Healthy-source results survive another source's failure.
- Exit status distinguishes complete success, degraded success, and fatal failure.

### Slice 4: safe writes and generated projections

Required planning and final review model: Opus.

Recommended implementation model after plan approval: Sonnet at high effort.

Goal: replace the manual Notion and Markdown dual-write process only after scheduler and discovery behavior are proven.

Deliverables:

- Stable external listing identity in the canonical schema.
- SQLite outbox and idempotency keys.
- Runtime-owned field writes only.
- Conflict detection and reconciliation.
- Atomic local Markdown and dashboard projections.
- Durable human approval records.

Acceptance criteria:

- Replayed writes cannot create duplicates.
- Concurrent human edits survive.
- Failed remote writes never appear successful locally.
- Unattended code cannot set `Applied`, submit an application, or message a third party.

## Continuation constraints

- Do not install a scheduler during the prerequisite cleanup, Slice 2.0, or Slice 2.1.
- Do not add job-board network access before Slice 3.1.
- Do not implement general browser automation.
- Do not add Notion writes before Slice 4.
- Do not submit applications, fill forms, send email, send LinkedIn messages, or contact recruiters.
- Do not redesign the dashboard or Notion schema as incidental cleanup.
- Do not combine roadmap slices into one branch or pull request.
- Preserve the model-free runtime boundary.

## Verification for every continuation slice

Run at minimum:

```text
npm run check
npm run build:public
git diff --check
```

Also review the complete changed-file list, confirm the branch started from current `origin/master`, run targeted tests, verify no private or generated file is publishable, and verify no OpenAI, Anthropic, MCP, Codex, or Claude runtime dependency was added.

Start by inspecting current `origin/master`, creating a fresh cleanup branch, and finalising the four mandatory stale-state points. Produce a concise plan before editing files.

---

## Historical completed handoff

The sections below record the already completed foundation task. They are retained for audit history and must not be executed as current instructions.

## 1. Objective

Continue the Job Hunt OS autonomy migration from the current working tree. Finish and verify the architecture foundation and first read-only implementation slice so the repository can compute a deterministic morning plan from Notion or a fixture without Codex, Claude Code, a browser agent, an LLM, or model API calls at runtime.

## 2. Current state

- Repository: `/Users/ethansimmons/job-hunt-os`.
- The existing application is a Markdown and dashboard workspace whose daily behavior is currently described in `.claude/commands` and `.claude/skills`.
- The working tree contains a new TypeScript runtime foundation under `src/`, tests under `tests/`, boundary checks under `scripts/`, a strict runtime config template, a public sample manifest, CI, and a public-only Vercel build.
- Implemented modules cover validated domain contracts, Melbourne business-date planning, a read-only Notion data-source adapter, a file snapshot adapter, an SQLite run ledger, workflow orchestration, CLI commands, and privacy/dependency boundary checks.
- The fixture plan is intentionally deterministic. The weekly rule is preserved exactly: a target is due only when its last check is more than seven days old. Missing dates, future dates, missing URLs, and inconsistent follow-up fields become review items, not guesses.
- The Notion connector was inspected live. The data-source identifier lives only in private `targets/runtime.json`. The live schema includes `Part-time Admin` in Role Type. A standalone runtime credential is required as `NOTION_TOKEN`; the connector credential must not be copied into the repository or runtime.
- Local Node is 26.7.0. The implementation targets Node 24.15.0 or newer and uses built-in `node:sqlite`; CI is configured for Node 24 and 26.
- Current verification is blocked at lint, before tests, by `no-control-regex` in `src/planner.ts` where the digest sanitizer uses a control-character regular expression. Fix that without weakening lint or emitting sensitive values.
- No remote Notion writes, job applications, messages, scheduling, browser automation, or LLM calls are in scope.

## 3. Decisions already made

Locked:

- The production runtime must be model-free. Codex and Claude Code are maintainers only.
- Notion remains the canonical source for targets and applications. Markdown remains a human-authored working area and must not be silently overwritten.
- Business timezone is `Australia/Melbourne`.
- Target cadence values are `daily` and `weekly`; the existing weekly `> 7 days` rule is contractual.
- The first slice is read-only. No Notion create, update, archive, submit, or messaging endpoint may be added.
- Public deployment may contain only the existing synthetic sample dashboard. Private profile, pipeline, prep, targets, runtime state, logs, credentials, and real Notion data must not be published.
- Every run must be observable and safe to repeat. The local SQLite ledger is private, mode-aware, and must not store tokens or raw provider errors.
- Never claim the live Notion path is operational without `NOTION_TOKEN` and a successful `doctor` or `plan` run against the configured data source.

Still open for review, but do not change casually:

- Exact live Notion property aliases for optional role, source URL, and applied date fields.
- Whether a later discovery phase should use an official job API or a separate browser worker. Do not add either in this slice.
- Scheduler choice and retention policy for the later write-free daily run.

## 4. Scope

1. Inspect the repository, `CLAUDE.md`, and the new implementation before changing anything.
2. Enter Plan Mode first and state the smallest implementation plan.
3. Fix the lint blocker and any compile, test, privacy, or boundary issues found by the verification suite.
4. Add only narrowly scoped tests or documentation needed to prove the current slice.
5. Ensure the CLI remains useful:
   - `npm run morning:plan -- --demo --at 2026-09-18T09:00:00+10:00`
   - `npm run doctor -- --demo`
   - `npm run check`
   - `npm run build:public`
6. If a live Notion check is attempted, use the configured standalone `NOTION_TOKEN` only and report missing credentials as an actionable diagnostic.
7. Produce `CLAUDE_TO_CHATGPT_HANDOFF.md` in the repository when complete, using the required return structure below.

## 5. Out of scope

- Do not add a scheduler, Notion writes, application submission, email or chat sending, browser automation, LLM inference, OpenAI or Anthropic SDKs, MCP runtime dependencies, or `claude`/`codex` subprocess calls.
- Do not migrate or overwrite the existing Markdown source of truth.
- Do not redesign the dashboard, public sample data, Notion schema, or product workflow.
- Do not add real company names, private identifiers, tokens, URLs, or user data to fixtures, tests, public output, logs, or documentation.
- Do not perform unrelated cleanup, dependency upgrades, or cosmetic refactors.

## 6. Relevant architecture, files, and systems

- `src/domain.ts`: Zod schemas for targets, applications, listings, decisions, and snapshots.
- `src/config.ts`: strict runtime configuration and source selection.
- `src/planner.ts`: pure Melbourne-date planner and digest generation.
- `src/notion.ts`: pinned Notion API reader restricted to data-source retrieve and query reads.
- `src/source.ts`: snapshot source abstraction and file adapter.
- `src/ledger.ts`: private `.runtime/runs.sqlite` ledger using Node `node:sqlite`.
- `src/workflow.ts`: source read, plan, hash, record success or failure.
- `src/cli.ts`: `plan` and `doctor`, demo/config selection, JSON and no-record modes.
- `scripts/check-boundaries.mjs`: AST, dependency, private-data, and public-sample guard.
- `scripts/build-public.mjs`: allowlisted synthetic public build.
- `tests/`: domain, planner, Notion adapter, workflow, CLI, and privacy tests.
- `templates/runtime-config.json`: safe configuration template with placeholder values only.
- `dashboard/`: existing synthetic public dashboard and manifest.
- `.github/workflows/verify.yml`: Node 24 and 26 verification.
- `vercel.json`: public build uses `npm run build:public` and `.public` only.

## 7. Constraints

- Follow existing `CLAUDE.md` repository rules, including no em dashes or en dashes in authored repo files.
- Use `apply_patch` for file edits. Preserve unrelated user changes.
- Keep provider errors redacted and diagnostics actionable without echoing secrets or private record contents.
- Keep Notion requests bounded, read-only, pinned to API version `2026-03-11`, and limited to the two allowed endpoints.
- Preserve deterministic ordering, date-only semantics, idempotent logical run keys, and atomic SQLite recording.
- A failed source read must not leave a stale successful plan visible for the same logical run key.

## 8. Acceptance criteria

- `npm run typecheck` passes.
- `npm run lint` passes without disabled rules or broad ignores.
- `npm test` passes on the checked-in fixture suite.
- `npm run privacy:check` passes and rejects forbidden runtime imports, dynamic code execution, private publishable files, and sample drift.
- `npm run build:public` creates only the allowlisted public output and never copies private state.
- Demo `plan` output is deterministic for a fixed timestamp and contains no real/private data.
- `doctor --demo` validates the source and reports target/application counts.
- Missing `NOTION_TOKEN` or malformed runtime config fails with a safe, actionable error and nonzero status.
- Actual SDK-backed Notion tests, if retained, prove GET metadata then POST query, pinned version headers, pagination, bounded retries, and no mutation methods.
- Tests cover repeat runs, changed input revisions, failed runs clearing stale artifacts, schema mismatches, cursor failures, date/timezone edges, symlink or permission protections, and malformed data without echoing values.
- The resulting code contains no runtime dependency on Codex, Claude Code, OpenAI, Anthropic, MCP, or an LLM.

## 9. Verification required

Run the complete check suite after changes. Also inspect `git diff --check`, the final publishable file list, and the boundary script output. If Node 24 is available, run the same tests there because `node:sqlite` is the selected runtime contract. If live Notion credentials are unavailable, say so explicitly and do not substitute the Notion connector credential.

## 10. Deliverables back to ChatGPT

Return a compact `CLAUDE_TO_CHATGPT_HANDOFF` containing:

- Summary of what changed
- Files changed
- Important implementation decisions
- Tests run and outcomes
- Known limitations or unresolved issues
- Any deviation from this supplied plan
- Recommended next step

Start by inspecting the existing implementation and produce a plan before making changes.
