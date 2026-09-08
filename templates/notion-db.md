# Notion target DB

Optional. If you track target companies in Notion, `job-scan` reads this file for
the database id. No Notion? Delete this file and ignore the Notion steps in
`job-scan` and `/log-app`; the skills fall back to `pipeline/*.md`.

## Database id

```
NOTION_TARGET_DB_ID = <paste the 32-char id from the database URL>
```

The id is the string between the workspace slug and the `?v=` in the DB URL:
`https://www.notion.so/<workspace>/<THIS_PART>?v=...`

## Auth

`job-scan` uses whatever Notion access your Claude Code session already has (MCP
connector or integration token). Set that up once in Claude Code; do not paste a
token into this file.

## Fields the target DB needs

| Property | Type | Used for |
|---|---|---|
| Company | Title | company name, or `[Saved Search] ...` for a recurring filter URL |
| Careers URL | URL | the page `job-scan` opens |
| Status | Select | `Active watch` rows are the ones scanned |
| Role Type | Select | e.g. `Priority`, `Part-time Admin` |
| Check Frequency | Select | `daily` or `weekly` (default weekly if empty) |
| Last Checked | Date | written by `job-scan` on every open; drives the skip / tiering logic |
| Latest Match | Text | role title + URL of the most recent match |

## Pipeline DB (optional, separate)

If you also mirror applications into Notion, `/log-app` and `/post-mortem` write
the same stage there as in `pipeline/*.md`. One row per application, with at least
`Company`, `Role`, `Stage`, `Applied date`, `Next action`, `Next action date`.
