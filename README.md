# Ghost-ProdPrelim

Preliminary repository for the GhostDash / Magic Mike production rebuild and code review.

## Purpose

This repository is the clean review point for the GhostDash production rebuild.

Initial contents are documentation-first. Implementation code should be added only after the runtime direction is locked.

## First build phase

Phase 1 must focus on the customer-facing production defects:

```text
- production chat route correctness
- Magic Mike consumer_customer runtime isolation
- Odoo hard-disable for Magic Mike
- phone-call preview/open streaming UX
- final transcript auto-send
- ElevenLabs selected voice audio playback
- barge-in
- guardrail path before display and speech
```

Admin console work is Phase 2 unless needed to unblock Phase 1.

## Critical rule

Do not make Magic Mike a document bot, finance bot, or generic RAG assistant.

Magic Mike is a Ride Electric consumer customer voice agent.

## Start here

Read:

```text
docs/INDEX.md
docs/CODE_REVIEW_PLAN.md
docs/PHASE_1_BUILD_BRIEF.md
```
