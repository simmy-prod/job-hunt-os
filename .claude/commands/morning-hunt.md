---
description: Daily job-hunt driver — scan for new matches, surface today's follow-ups, one drill rep.
---

Run the daily job hunt loop:

1. Run the `job-scan` skill against the Notion target DB. Report new matches.
2. Read `pipeline/*.md` frontmatter, list anything with `next_action_date` <= today.
3. Pick the weakest-confidence story from `profile/skills-matrix.md` (or ask which
   company's interview is coming up soonest) and run one `interview-drill` round
   (3-5 questions) in that context.
4. Close with a one-line status: matches found, follow-ups due, drill done.

Keep the whole loop to what fits in ~20-30 minutes — this is meant to run daily,
not become its own chore.
