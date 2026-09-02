---
name: profile-interview
description: Interviews Simmy to extract accomplishments, skills, and STAR stories, then writes them to profile/ as structured markdown. Use when building or updating the profile — first-time setup, after a new project/role, or before a resume/interview prep push finds a gap.
---

# Profile interview

Purpose: turn what's in Simmy's head into files other skills and future Claude
sessions can build on. This is the foundation skill — everything else in this repo
(resume help, interview prep, dashboards) is only as good as `profile/`.

## Process

Run as a live conversation, not a form dump. One question at a time, follow up on
vague answers, don't let a good story get flattened into a bullet point.

### Round 1 — orientation (5 min)
- Current situation: what's urgent (stable income), what's the dream (AI-native role)
- Confirm/update `targets/search-criteria.md` (roles, location, salary floor,
  dealbreakers, working rights)

### Round 2 — accomplishments (main event, 30-40 min)
For each job/project (start with Ragpiq), dig for 2-4 stories using STAR:
- **Situation** — context, stakes
- **Task** — what was actually asked of him
- **Action** — what HE did, specifically (not "we" — pin down his contribution)
- **Result** — outcome, ideally with a number

Push past the first answer. "What was hard about that?" / "What would've happened
if you hadn't caught that?" / "How did you actually build that, technically?" —
generic answers make weak interview material; specific ones are gold.

Tag each story with which skills it demonstrates (e.g. `ai-integration`,
`debugging`, `ownership`, `communication`, `speed-of-learning`).

### Round 3 — skills matrix
Build `profile/skills-matrix.md`: skill → evidence (which story proves it) → how
confidently he can talk to it (1-5). Be honest about the 2s and 3s — that's what
`interview-drill` will target.

### Round 4 — the Ragpiq AI deep-dive
Ragpiq is the headline credential. Get specific: what AI systems/tools did he
build or integrate, what was the architecture, what problem did it solve, what
would he do differently. Write to `profile/ragpiq/`.

## Output files

- `profile/master-profile.md` — 1-page summary: who he is, what he wants, headline pitch
- `profile/accomplishments/<slug>.md` — one file per STAR story
- `profile/skills-matrix.md`
- `profile/ragpiq/deep-dive.md`
- Update `targets/search-criteria.md` in place

## Rules

- Never invent detail he didn't give you. If a story is thin, mark it thin — don't
  pad it.
- This is gitignored — write freely, no need to sanitize for a public audience.
- Re-run anytime a new accomplishment happens (new project, praise from a manager,
  a hard bug fixed) — append, don't wait for a full re-interview.
