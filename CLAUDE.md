# Job Hunt OS: operating instructions

This repo runs Simmy's job search. Read this before touching anything in here.

## Who Simmy is

Fresh grad, Melbourne AU, ex-Ragpiq (AI skills built there). Needs stable income now.
Targeting: IT Desk, AI-Native Software Engineer/Developer, AI-Native Front-end
Designer, and adjacent roles that lean heavily on AI tooling. Full detail lives in
`profile/master-profile.md` and `targets/search-criteria.md`. Read both before any
prep or application task.

## The three layers: don't cross them

1. **`profile/`**: private. Accomplishments, skills matrix, STAR stories. Source
   of truth for anything Simmy says about himself. Never invent an accomplishment
   not backed by a file here. If prep needs something that isn't there, ask him or
   flag the gap, don't fabricate.
2. **`.claude/`, `dashboard/`, `scripts/`**: public, the showcase. Keep this code
   clean and documented; it's read by employers.
3. **`pipeline/`, `prep/`, Notion**: private working data. Notion is the source
   of truth for company targets and application stage. There is no automatic
   Notion-to-local sync, so any skill that changes a stage (`job-scan`,
   `/log-app`, `/post-mortem`) must write that change to BOTH the Notion row and
   the matching `pipeline/*.md` in the same pass, or the two drift.
   `pipeline/*.md` is the local cache the dashboard builds from.

## Workflows

**First-time setup:** run `profile-interview` before anything else. Every other
skill reads `profile/`; if it is empty they all degrade to generic output.
Re-run it whenever a new accomplishment happens (append, don't re-interview).

**Daily:** `/morning-hunt` is the default entry point.
1. `job-scan` against the Notion target DB, report new matches. `job-scan` only
   opens rows actually due a check (see the `Check Frequency` convention below),
   so it is cheap to re-run.
2. List `pipeline/*.md` whose `next_action_date` <= today.
3. One `interview-drill` round (3-5 Q) against the lowest-confidence skill in
   `profile/skills-matrix.md`, or the soonest upcoming interview if prep exists.
   Skip step 3 on a busy day; steps 1-2 are the part that must not lapse.

**Per application / interview:**
- `/log-app` - log a new application to Notion + `pipeline/` + rebuild dashboard.
- `company-deep-dive` - once an interview is booked, a few days out. Heavy
  (runs `deep-research`); never wire it into the daily loop.
- `interviewer-recon` - once an interviewer's name is known.
- `/drill <mode>` where mode is `recruiter`, `hiring-manager`, `technical`, or
  `ai-native` - targeted rehearsal, straight into that mode, no menu.
- `/post-mortem` - immediately after an interview, while it is fresh.

**Viewing the dashboard:** `npm start` from the repo root runs the build (writes
`dashboard/data.local.json` from `pipeline/*.md`) then serves it at
http://localhost:8000 (badge "live pipeline data"). It must be served, not opened
as a `file://` path, or the page falls back to sample data. This is local only;
the Vercel deploy always renders `dashboard/data.json` (fictional sample).

## Conventions

- One `.md` file per accomplishment in `profile/accomplishments/`, STAR format
  (Situation / Task / Action / Result), tagged with which skills it demonstrates.
- One `.md` file per application in `pipeline/`, YAML frontmatter:
  `company, role, stage, applied_date, source_url, contact, next_action, next_action_date`.
- When `job-scan` opens a new `pipeline/` entry for a match, set
  `next_action: Run company-deep-dive` and `next_action_date` 2-3 days out, so
  the match resurfaces in `/morning-hunt` step 2 instead of going silent.
- Notion target rows carry a `Check Frequency` field (`daily` / `weekly`,
  default weekly). `job-scan` scans `daily` rows every run and `weekly` rows only
  when `Last Checked` is more than 7 days old, and skips any row already checked
  today. It writes `Last Checked` = today on every row it opens.
- New `pipeline/` entries default to stage `Researching`. `/log-app` only sets
  `Applied` after Simmy confirms he actually submitted (see rule below).
- One folder per company in `prep/<company-slug>/`: `research.md`,
  `interviewer-brief.md`, `questions.md`.
- Whenever prepping a cover note or tailored resume for a real application,
  also write `prep/<company-slug>/gpt-prompt.md`: a self-contained, engineered
  prompt Simmy can paste into ChatGPT (GPT Go) to generate or refine that
  cover note or resume himself. Ground it only in facts already in `profile/`
  and the target job ad, state the no-em-dash/en-dash rule explicitly inside
  the prompt, and never fabricate experience, numbers, or skills beyond what's
  given.
- `scripts/build-dashboard.mjs` reads `pipeline/*.md` and writes
  `dashboard/data.local.json` (gitignored, real data; the dashboard fetches it
  first and falls back to sample). Never hand-edit `data.local.json`.
  `dashboard/data.json` is hand-maintained sample data for the public Vercel
  deploy, keep it fake. Re-run the build after any `pipeline/` change
  (`/log-app` and `/post-mortem` already do).
- Never mark an application "Applied" in the pipeline without Simmy confirming he
  actually submitted it.

## Style rule

**No em-dashes or en-dashes (— / –) anywhere in this repo, in any document,**
resume, cover note, or generated file. Use a period, comma, colon, semicolon,
parentheses, or a plain hyphen (-) instead. Applies to everything written from
now on, and to anything edited going forward, no exceptions.

## Standing rule

Anything that would message a third party (application submission, LinkedIn
message, email to a recruiter) needs explicit go-ahead in chat first, every time.
