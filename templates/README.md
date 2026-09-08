# Templates

Starter files for the private layer. Nothing in here is used at runtime; copy
what you need into place, then edit.

The private directories (`profile/`, `pipeline/`, `prep/`, `targets/`) are
gitignored. You create them locally:

```bash
mkdir -p targets profile/accomplishments pipeline prep

cp templates/search-criteria.md    targets/search-criteria.md
cp templates/notion-db.md          targets/notion-db.md
cp templates/master-profile.md     profile/master-profile.md
cp templates/skills-matrix.md      profile/skills-matrix.md
cp templates/accomplishment-STAR.md profile/accomplishments/example.md
cp templates/pipeline-entry.md     pipeline/example-company.md
```

Then:

1. Fill `targets/search-criteria.md` by hand (roles, location, salary floor,
   dealbreakers, working rights).
2. Run the `profile-interview` skill in Claude Code to populate `profile/` from a
   real conversation. Do not hand-write the accomplishment files if you can help
   it; the interview pulls out better detail.
3. If you use Notion for targets, set up the database and record its id in
   `targets/notion-db.md`. If you do not, `job-scan` and `/log-app` still work
   against `pipeline/*.md` alone; skip the Notion steps in those skills.

| Template | Copy to | Filled by |
|---|---|---|
| `search-criteria.md` | `targets/search-criteria.md` | you, by hand |
| `notion-db.md` | `targets/notion-db.md` | you, by hand |
| `master-profile.md` | `profile/master-profile.md` | `profile-interview` |
| `skills-matrix.md` | `profile/skills-matrix.md` | `profile-interview` |
| `accomplishment-STAR.md` | `profile/accomplishments/<slug>.md` | `profile-interview` |
| `pipeline-entry.md` | `pipeline/<company-slug>.md` | `job-scan` / `/log-app` |
