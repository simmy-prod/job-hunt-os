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
3. **`pipeline/`, `prep/`, Notion**: private working data. Notion DB is the source
   of truth for company targets and application stage; `pipeline/*.md` is a local
   cache synced from it for the dashboard build.

## Daily loop

`/morning-hunt` is the default entry point most days:
1. Run `job-scan` against the Notion target DB.
2. Report new matches + anything due a follow-up today.
3. Run one round of `interview-drill` on the weakest logged story.

## Conventions

- One `.md` file per accomplishment in `profile/accomplishments/`, STAR format
  (Situation / Task / Action / Result), tagged with which skills it demonstrates.
- One `.md` file per application in `pipeline/`, YAML frontmatter:
  `company, role, stage, applied_date, source_url, contact, next_action, next_action_date`.
- One folder per company in `prep/<company-slug>/`: `research.md`,
  `interviewer-brief.md`, `questions.md`.
- Dashboard rebuilds from `pipeline/*.md` via `scripts/build-dashboard.mjs`. Never
  hand-edit `dashboard/data.json`.
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
