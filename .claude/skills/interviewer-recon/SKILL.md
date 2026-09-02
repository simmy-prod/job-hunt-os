---
name: interviewer-recon
description: Uses Claude in Chrome to research a named interviewer's public LinkedIn profile and recent posts, then briefs what they likely care about and might ask. Use once an interviewer's name is known, ahead of that interview.
---

# Interviewer recon

Purpose: walk into the room already knowing what this specific person values.

## Process

1. Confirm with Simmy: interviewer's full name, company, role in the process
   (recruiter / hiring manager / peer / panel).
2. Claude in Chrome: search LinkedIn for the person, open their public profile.
3. Read: current role + tenure, career path (what they've done before this),
   any About-section language, recent posts/comments/reshares (last ~3-6 months).
4. Look for signal, not gossip: what do they post about (specific tools, team
   values, hiring philosophy, pet peeves)? Any clue about how they run interviews?
5. Write `prep/<company>/interviewer-brief.md`:
   - Who they are, career path in 3 lines
   - What they seem to care about (backed by specific posts, quoted briefly)
   - Likely angle for this interview given their role in the process
   - 3-5 tailored questions Simmy could ask them specifically

## Rules

- Public profile info only — no scraping behind a login wall beyond Simmy's own
  normal LinkedIn access.
- Never message, connect with, or comment on the interviewer's content — recon
  only, this stays passive.
- If the profile is locked down / low signal, say so plainly rather than
  stretching thin material into a false-confidence brief.
