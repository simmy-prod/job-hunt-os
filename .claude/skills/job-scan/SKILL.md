---
name: job-scan
description: Checks each company in the Notion target DB for new job listings matching search criteria, logs matches to Notion and pipeline/. Use daily (via /morning-hunt) or on demand.
---

# Job scan

Purpose: replace manually checking a dozen careers pages with one pass.

## Process

1. Read `targets/search-criteria.md` for what counts as a match.
2. Query the Notion target DB (see `targets/notion-db.md` for the DB ID) for
   companies with status `Active watch`. Then narrow to the rows actually due a
   check this run:
   - Respect the `Check Frequency` field: scan `daily` rows every run, `weekly`
     rows only when `Last Checked` is more than 7 days ago. A row with no value
     defaults to weekly.
   - Skip any row whose `Last Checked` is already today. This skill can be run
     more than once a day (a re-run of `/morning-hunt`, an on-demand scan) and
     must not re-open pages it just saw.
3. For each company due a check, open its careers page URL (Claude in Chrome,
   Simmy's own session, never a headless scrape of a site that blocks bots) and
   check for listings matching the priority roles.
   - **Exception, rows tagged `Role Type: Part-time Admin`:** this track is
     high-churn across many small employers, not a fixed company list. A row
     whose Company name starts with `[Saved Search]` represents a recurring
     search (e.g. a SEEK filtered URL) rather than one employer, open it,
     scan the current listings against the part-time-admin criteria in
     `targets/search-criteria.md` (20-25 hrs/week, $25+/hr, remote/hybrid OK,
     no experience required), and log any real match as its own new company
     row (or `pipeline/` entry) rather than updating the saved-search row's
     own "Latest Match" field.
4. After checking a row, set its Notion `Last Checked` = today (matched or not),
   so the tiering and same-day skip in step 2 stay accurate.
5. For each new match:
   - Set the Notion row's `Latest Match` = role + URL.
   - If it's a strong match, create/update `pipeline/<company>.md` at stage
     `Researching`, and set `next_action: Run company-deep-dive` with
     `next_action_date` 2-3 days out, so the match resurfaces in `/morning-hunt`
     step 2 instead of going silent.
6. Summarize: X companies checked, Y new matches, list them with links.

## Rate limits / etiquette

- Space out requests, don't hammer a site. A normal run touches only the rows due
  a check (step 2), not the whole watch list.
- If a site blocks automated access or requires login Simmy doesn't have open,
  skip it and flag it rather than trying to force through.
- Never submit anything, click "Apply", or fill a form during a scan, read-only.

## Output

A short digest, plus Notion + `pipeline/` updates. `/morning-hunt` calls this
first and surfaces the digest.
