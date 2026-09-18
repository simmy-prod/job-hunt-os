# ChatGPT to Claude Code Handoff

## 1. Objective

Continue the Job Hunt OS autonomy migration from the current working tree. Finish and verify the architecture foundation and first read-only implementation slice so the repository can compute a deterministic morning plan from Notion or a fixture without Codex, Claude Code, a browser agent, an LLM, or model API calls at runtime.

## 2. Current state

- Repository: `/Users/ethansimmons/job-hunt-os`.
- The existing application is a Markdown and dashboard workspace whose daily behavior is currently described in `.claude/commands` and `.claude/skills`.
- The working tree contains a new TypeScript runtime foundation under `src/`, tests under `tests/`, boundary checks under `scripts/`, a strict runtime config template, a public sample manifest, CI, and a public-only Vercel build.
- Implemented modules cover validated domain contracts, Melbourne business-date planning, a read-only Notion data-source adapter, a file snapshot adapter, an SQLite run ledger, workflow orchestration, CLI commands, and privacy/dependency boundary checks.
- The fixture plan is intentionally deterministic. The weekly rule is preserved exactly: a target is due only when its last check is more than seven days old. Missing dates, future dates, missing URLs, and inconsistent follow-up fields become review items, not guesses.
- The Notion connector was inspected live. The target data source ID is `97948a83-301d-4673-b6b4-52f7f60d0357`. The live schema includes `Part-time Admin` in Role Type. A standalone runtime credential is still required as `NOTION_TOKEN`; the connector credential must not be copied into the repository or runtime.
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
