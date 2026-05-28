# GhostDash Retail Agent Builder Skill

## Summary

Added a project-local Cursor skill and two split retail rules for customer-facing GhostDash agent work.

Files added:

- `.cursor/skills/ghostdash-retail-agent-builder/SKILL.md`
- `.cursor/rules/magic-mike-retail-agent.mdc`
- `.cursor/rules/magic-mike-retail-output-guard.mdc`

## Intent

This change gives the repo a persistent instruction set for:

- Magic Mike behavior as a Ride Electric representative
- customer-safe retail and service responses
- Hubtiger booking, quote, and job flows
- ElevenLabs voice reply behavior
- evidence-backed pricing, stock, availability, legal, and booking claims

## Rule split

The behavior is intentionally split:

1. `magic-mike-retail-agent.mdc`
   - defines agent behavior and domain rules
2. `magic-mike-retail-output-guard.mdc`
   - defines the final customer-facing output safety gate

## Main protections

- no internal diagnostics in public replies
- no guessing on price, stock, bookings, jobs, or legal claims
- safe fallback rewrite on tool failure
- no Finance Agent formatting for Magic Mike
- Ride Electric-first product positioning
- short conversational voice replies

## Validation to perform

- Open the new skill in Cursor and confirm it appears under project skills.
- Confirm both new rule files load with valid frontmatter.
- Run retail prompt checks against the listed validation cases in the skill.
