---
description: Log a new application to the pipeline (Notion + pipeline/*.md) and rebuild the dashboard.
---

Log a new job application:

1. Ask for whatever's missing: company, role, source URL, date applied, contact
   (if known), stage (default `Applied`).
2. Create/update `pipeline/<company-slug>.md` with YAML frontmatter:
   `company, role, stage, applied_date, source_url, contact, next_action, next_action_date`.
3. Update the matching row in the Notion pipeline DB (create one if it doesn't exist).
4. Run `node scripts/build-dashboard.mjs` to regenerate `dashboard/data.json`.
5. Confirm what was logged in one line.

Never mark stage `Applied` without Simmy confirming he actually submitted it.
