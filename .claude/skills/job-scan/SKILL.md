---
name: job-scan
description: Checks each company in the Notion target DB for new job listings matching search criteria, logs matches to Notion and pipeline/. Use daily (via /morning-hunt) or on demand.
---

# Job scan

Purpose: replace manually checking a dozen careers pages with one pass.

## Process

1. Read `targets/search-criteria.md` for what counts as a match.
2. Query the Notion target DB (see `targets/notion-db.md` for the DB ID) for
   companies with status `Active watch`.
3. For each company, open its careers page URL (Claude in Chrome, Simmy's own
   session — never a headless scrape of a site that blocks bots) and check for
   listings matching the priority roles.
   - **Exception — rows tagged `Role Type: Part-time Admin`:** this track is
     high-churn across many small employers, not a fixed company list. A row
     whose Company name starts with `[Saved Search]` represents a recurring
     search (e.g. a SEEK filtered URL) rather than one employer — open it,
     scan the current listings against the part-time-admin criteria in
     `targets/search-criteria.md` (20-25 hrs/week, $25+/hr, remote/hybrid OK,
     no experience required), and log any real match as its own new company
     row (or `pipeline/` entry) rather than updating the saved-search row's
     own "Latest Match" field.
4. For each new match:
   - Update the company's Notion row: `Last Checked` = today, `Latest Match` = role + URL
   - If it's a strong match, create/update a `pipeline/<company>.md` with stage
     `Researching`
5. Summarize: X companies checked, Y new matches, list them with links.

## Rate limits / etiquette

- Space out requests, don't hammer a site — this runs once a day, not in a loop.
- If a site blocks automated access or requires login Simmy doesn't have open,
  skip it and flag it rather than trying to force through.
- Never submit anything, click "Apply", or fill a form during a scan — read-only.

## Output

A short digest, plus Notion + `pipeline/` updates. `/morning-hunt` calls this
first and surfaces the digest.
