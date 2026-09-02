---
name: company-deep-dive
description: Runs deep research on a company ahead of an interview and builds a prep doc plus expert-sounding questions, cross-referenced against Simmy's own accomplishments. Use once an interview is scheduled, a few days before it.
---

# Company deep dive

Purpose: walk in sounding like someone who's followed this company, not someone
who read the About page five minutes ago.

## Process

1. Confirm company + role + interview stage with Simmy.
2. Run the `deep-research` skill (or equivalent thorough multi-source research) on:
   - What they actually build/sell, and for whom
   - Recent news: funding, launches, leadership changes, layoffs (last 6-12 months)
   - Their engineering/product blog or public tech talks — what stack, what
     problems they talk about publicly
   - Where AI shows up in their product or their public hiring language
   - Competitors and what makes this company different
3. Cross-reference against `profile/`: which of Simmy's stories map to problems
   this company actually has? Flag the 2-3 strongest connections.
4. Write `prep/<company>/research.md` — organized under the headings above, each
   claim sourced.
5. Write `prep/<company>/questions.md` — 8-10 questions split into:
   - Questions that prove he did the homework (specific, not googleable-generic)
   - Questions that surface real decision-relevant info for him (culture, growth,
     how AI tooling is actually used day-to-day)

## Rules

- Source everything — no confident-sounding claims about the company that can't
  be traced to something found in research.
- If research surfaces something concerning (layoffs, bad reviews, instability),
  report it straight in the doc — don't bury it to keep the prep doc upbeat.
