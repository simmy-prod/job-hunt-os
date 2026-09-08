---
company: Example Company
role: AI-Native Software Engineer
stage: Researching
applied_date: ""
source_url: https://jobs.example.org/example-company/role
contact: ""
next_action: Run company-deep-dive
next_action_date: 2026-01-15
---

One file per application, at `pipeline/<company-slug>.md`. The YAML frontmatter
above is the contract the dashboard build reads; the body below is free notes.

Field rules:

- `stage`: one of `Researching`, `Applied`, `Screen`, `Interview`, `Final`,
  `Offer`, `Closed`. New entries start at `Researching`. Only move to `Applied`
  once you have actually submitted.
- `applied_date` / `next_action_date`: `YYYY-MM-DD`, or `""` if not set.
  `/morning-hunt` surfaces any entry whose `next_action_date` is today or past.
- `next_action`: the single next thing to do. `job-scan` sets this to
  `Run company-deep-dive` with a date 2 to 3 days out for fresh matches.
- Keep this file and the Notion row (if you use one) in sync on `stage`.

## Notes

Anything useful: recruiter name, referral, why this role, prep status, links.
