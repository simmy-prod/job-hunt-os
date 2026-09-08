---
description: Interview drill in a given mode (recruiter | hiring-manager | technical | ai-native). Skips the mode menu, straight to question 1.
---

Run the `interview-drill` skill directly in the mode named in `$ARGUMENTS`
(`recruiter`, `hiring-manager`, `technical`, or `ai-native`). Skip the "which
mode" question and go straight to question 1. If no mode is given, ask once.

Mode context:

- **recruiter**: pull the salary floor and availability constraints from
  `targets/search-criteria.md` so the salary-expectations question drills against
  his real number, not a guess.
- **hiring-manager**: pull from `profile/accomplishments/` broadly; weight toward
  the leadership and workflow-discipline stories.
- **technical**: if a company is at stage `Interview` or `Final` in `pipeline/`,
  pull its `prep/<company>/` context and take the stack from there. Otherwise
  pull from `profile/accomplishments/` and weight toward the lowest-confidence
  skills in `profile/skills-matrix.md`.
- **ai-native**: weight toward the strongest AI-native material in the profile,
  `profile/ragpiq/deep-dive.md` and the AI-tagged files in
  `profile/accomplishments/`. This material earns disproportionate rehearsal
  time; do not name specific projects here, read them from the profile.
