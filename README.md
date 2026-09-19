# Job Hunt OS

A self-operated system for running a job search like a product - built and maintained
using [Claude Code](https://claude.com/claude-code) as the daily driver.

Built by Simmy, a fresh grad job-hunting in Melbourne, AU for Business Analyst,
Admin, and adjacent non-coding roles (software/front-end work stays in his separate
SimmyProd persona). This repo *is* the search: the same AI workflow habits I'd bring
into a role that values them, applied to landing one.

## Why this exists

Job hunting is a pile of disconnected chores: track companies, tailor prep, rehearse
answers, remember what stage everything is at. Most people run it in their head and it
falls apart after week two. This repo turns it into a system with daily touchpoints,
so nothing gets dropped and every interview walks in prepared.

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────┐
│   Notion     │────▶│  job-hunt-os      │────▶│   Dashboard    │
│  (target DB, │     │  (this repo)      │     │  Kanban view   │
│  source of   │◀────│  runtime + Claude │     └───────────────┘
│  truth)      │     │  Code skills      │
└─────────────┘     └──────────────────┘
                            │
                     ┌──────┴──────┐
                     │  profile/    │  private - accomplishments,
                     │  pipeline/   │  applications, prep docs
                     │  targets/    │  (gitignored, local only)
                     └─────────────┘
```

Two layers do the daily work, and they're deliberately separate:

- **Deterministic runtime** (`src/`, run via `npm run morning:plan` and
  `npm run doctor`): a plain Node.js program, no model or LLM API calls.
  It reads the Notion target database through Notion's read-only API and
  computes which targets are due, which follow-ups are due today, and which
  rows need human review. A separate `npm run writes` command group can set
  a small allowlist of Notion fields (Last Checked, Next Action and its
  date, Pipeline Stage) through a local outbox with idempotency keys,
  read-back conflict checks, and a dry run by default. Anything beyond
  Last Checked needs a human to approve it in an interactive terminal, and
  `Applied` additionally needs a typed confirmation that the application
  was already submitted by hand. It never submits applications or sends
  messages. See [`docs/runtime.md`](docs/runtime.md) for the full contract.
- **Claude Code skills** (`.claude/skills`, `.claude/commands`): the
  user-invoked, judgment-requiring work the deterministic runtime doesn't
  do - scanning job boards, researching companies and interviewers, drilling
  interview answers, and writing STAR-format accomplishments. These still
  need Claude Code and a human in the loop.

**Three layers, one repo:**

| Layer | What | Tracked in git? |
|---|---|---|
| **Brain** | `profile/` - STAR stories, skills matrix, interview answers | No (private) |
| **Machine** | `.claude/skills`, `.claude/commands`, `dashboard/`, `scripts/` | **Yes - this is the showcase** |
| **Pipeline** | Notion DB (truth) + `pipeline/`, `prep/`, `targets/` (all local, gitignored) | No (private) |

The public repo is the engineering: skills, automation, dashboard code. The private
data (who I am, who I'm talking to, what I said in an interview) stays local.

## The 5 skills

| Skill | Does |
|---|---|
| `profile-interview` | Structured interview → writes STAR-format accomplishment files |
| `job-scan` | Checks target companies' job boards against search criteria, logs matches |
| `interviewer-recon` | Researches a named interviewer's public profile + recent posts, briefs their likely angle |
| `company-deep-dive` | Deep research on a company pre-interview → prep doc + expert-level questions |
| `interview-drill` | Mock interview by type (recruiter / hiring manager / technical / AI-native), scores + coaches answers |

Plus `/morning-hunt` - the daily driver: scan → surface new matches + today's follow-ups
→ one drill rep.

## Dashboard

Kanban board (`Researching → Applied → Screen → Interview → Final → Offer/Closed`),
generated from `pipeline/*.md` frontmatter, deployed live on Vercel.

**Live:** [job-hunt-os-one.vercel.app](https://job-hunt-os-one.vercel.app) _(interactive demo on fictional sample data; the real pipeline stays local and private)_

## Stack

Claude Code (skills + commands), Notion (source of truth for targets/pipeline),
Claude in Chrome (job board + LinkedIn research), static HTML/JS dashboard on Vercel.

## Run it yourself

This was built for one job search, but the machine layer is generic. To point it
at your own:

**Prerequisites:** [Claude Code](https://claude.com/claude-code) for the
skills, Node.js 24.15.0+ for the deterministic runtime (`node:sqlite` needs
it; see [`docs/runtime.md`](docs/runtime.md)). Optional: a Notion database
for target companies, a Vercel account to host your own dashboard.

**Setup:**

1. Clone the repo, then `npm install` (installs the runtime's two
   dependencies, `@notionhq/client` and `zod`, plus dev tooling for
   typecheck/lint/test).
2. Create the private layer from the starter files: follow
   [`templates/README.md`](templates/README.md). The `profile/`, `pipeline/`,
   `prep/`, and `targets/` directories are gitignored, so you build them locally.
3. Fill `targets/search-criteria.md` by hand (roles, location, salary floor,
   dealbreakers, working rights).
4. Run the `profile-interview` skill in Claude Code. It interviews you and writes
   `profile/` (STAR stories, skills matrix, headline pitch). Everything else is
   only as good as this step.
5. If you use Notion, set up the target database and record its id in
   `targets/notion-db.md` (fields listed in that template). If you do not,
   `job-scan` and `/log-app` still work against `pipeline/*.md` alone.
6. To run the deterministic morning planner against that Notion database,
   copy `templates/runtime-config.json` to `targets/runtime.json`, fill in
   your data source id and field mapping, create a standalone Notion
   integration token, and export it as `NOTION_TOKEN`. Full details,
   including why the token must be separate from any Notion connector
   Claude Code itself uses, are in [`docs/runtime.md`](docs/runtime.md).

**Daily use:** run `/morning-hunt` in Claude Code for the scan, follow-up
surfacing, and one interview-drill rep. `npm run morning:plan` and
`npm run doctor` run the deterministic, model-free due-date check on their
own, without Claude Code, if you just want that part.

**Run it unattended (macOS, optional):** `npm run schedule -- install`
writes a per-user LaunchAgent that runs the same read-only planner once per
business day, reading the Notion token from the login Keychain. It is off
unless `schedule.enabled` is set in `targets/runtime.json`. Setup, the
operational contract, and how to disable it are in
[`docs/runtime.md`](docs/runtime.md#scheduling-macos-launchagent).

**View your pipeline:**

```bash
npm start
```

Builds `dashboard/data.local.json` from your `pipeline/*.md` and serves the board
at http://localhost:8000 (badge: "live pipeline data"). It must be served, not
opened as a `file://` path, or the browser blocks the data fetch and the page
falls back to sample data.

**Deploy your own dashboard (optional):** point Vercel at the repo; it already
runs `npm run build:public` as its build command with `.public` as the output
directory (see [`vercel.json`](vercel.json)). That build copies only
`dashboard/index.html` and `dashboard/data.json` into `.public/`. Your real
`dashboard/data.local.json` is gitignored and never leaves your machine.
Replace `data.json` with your own fictional showcase set, or leave the sample
in place.

## Status

🚧 Actively in use - this is a running system, not a finished snapshot.
