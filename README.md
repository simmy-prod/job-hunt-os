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
│  (target DB, │     │  (this repo)      │     │  (Vercel)      │
│  source of   │◀────│  Claude Code +    │     │  Kanban view   │
│  truth)      │     │  5 custom skills  │     └───────────────┘
└─────────────┘     └──────────────────┘
                            │
                     ┌──────┴──────┐
                     │  profile/    │  private - accomplishments,
                     │  pipeline/   │  applications, prep docs
                     │  prep/       │  (gitignored, local only)
                     └─────────────┘
```

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

**Prerequisites:** [Claude Code](https://claude.com/claude-code), Node.js 18+.
Optional: a Notion database for target companies, a Vercel account to host your
own dashboard.

**Setup:**

1. Clone the repo, then `npm install` (there are no dependencies; this just
   enables the `npm` scripts).
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

**Daily use:** run `/morning-hunt` in Claude Code. Scan for new matches, surface
follow-ups due today, one interview-drill rep.

**View your pipeline:**

```bash
npm start
```

Builds `dashboard/data.local.json` from your `pipeline/*.md` and serves the board
at http://localhost:8000 (badge: "live pipeline data"). It must be served, not
opened as a `file://` path, or the browser blocks the data fetch and the page
falls back to sample data.

**Deploy your own dashboard (optional):** point Vercel at the repo with
`outputDirectory` set to `dashboard/` (see [`vercel.json`](vercel.json)). Only
`dashboard/data.json` is committed and deployed; your real `data.local.json` is
gitignored and never leaves your machine. Replace `data.json` with your own
fictional showcase set, or leave the sample in place.

## Status

🚧 Actively in use - this is a running system, not a finished snapshot.
