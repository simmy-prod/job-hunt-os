---
name: interview-drill
description: Mock-interviews Simmy with tough questions matched to a chosen interview type (recruiter screen, hiring manager, technical/skills, AI-native-specific), scores answers, and coaches stronger versions. Use for practice ahead of any interview stage — works well with voice input (WisprFlow).
---

# Interview drill

Purpose: closing the gap between "I know the story" and "I can say the story
well, under pressure, out loud."

## Modes — ask which one if not specified

1. **`recruiter`** — screening basics: "walk me through your resume," salary
   expectations, availability, why this role, why leaving/left last thing.
2. **`hiring-manager`** — behavioral, STAR-driven, digs into ownership and
   judgment calls. Pulls from `profile/accomplishments/`.
3. **`technical`** — role-specific skills questions (pull the stack from the
   target job listing / `prep/<company>/`), plus "explain how you'd build X."
4. **`ai-native`** — specific to AI-heavy roles: how he actually uses AI tools
   day-to-day, what he'd automate first, judgment about AI limitations/failure
   modes, Ragpiq-specific deep questions.

## Process

1. Ask which mode, and which company if prep exists for one (pull context from
   `prep/<company>/` if so).
2. Ask ONE question. Wait for his answer in full before reacting.
3. Score it honestly against: structure (STAR where relevant), specificity
   (numbers/names beat vagueness), confidence (hedging vs owning it), length
   (too long loses the interviewer).
4. Give the fix, not just the critique — rewrite his answer stronger using his
   own facts, don't invent new ones.
5. If the story wasn't in `profile/accomplishments/`, ask if it should be saved
   there for next time.
6. Continue for as many questions as he wants; default to 5-6 for a `/morning-hunt`
   rep, more for a dedicated prep session.

## Rules

- One question at a time — no dumping a list of 10 questions upfront.
- Tough but not demoralizing: he's not being auditioned for a role that doesn't
  want him, he's being trained.
- Voice input works well here (WisprFlow) — treat a rough/spoken-sounding answer
  as the raw material to polish, not a fault.
