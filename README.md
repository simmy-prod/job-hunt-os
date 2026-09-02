# Job Hunt OS

A self-operated system for running a job search like a product — built and maintained
using [Claude Code](https://claude.com/claude-code) as the daily driver.

Built by Simmy, a fresh grad job-hunting in Melbourne, AU for AI-native engineering /
front-end / IT roles. This repo *is* the search: the same AI workflow habits I'd bring
into an AI-native role, applied to landing one.

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
                     │  profile/    │  private — accomplishments,
                     │  pipeline/   │  applications, prep docs
                     │  prep/       │  (gitignored, local only)
                     └─────────────┘
```

**Three layers, one repo:**

| Layer | What | Tracked in git? |
|---|---|---|
| **Brain** | `profile/` — STAR stories, skills matrix, interview answers | No (private) |
| **Machine** | `.claude/skills`, `.claude/commands`, `dashboard/`, `scripts/` | **Yes — this is the showcase** |
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

Plus `/morning-hunt` — the daily driver: scan → surface new matches + today's follow-ups
→ one drill rep.

## Dashboard

Kanban board (`Researching → Applied → Screen → Interview → Final → Offer/Closed`),
generated from `pipeline/*.md` frontmatter, deployed live on Vercel.

**Live:** _(link added after first deploy)_

## Stack

Claude Code (skills + commands), Notion (source of truth for targets/pipeline),
Claude in Chrome (job board + LinkedIn research), static HTML/JS dashboard on Vercel.

## Status

🚧 Actively in use — this is a running system, not a finished snapshot.
