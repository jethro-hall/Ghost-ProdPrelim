# Ghost-ProdPrelim Documentation Index

This repository is the preliminary control pack for rebuilding and auditing GhostDash, Magic Mike, production chat, phone-call voice mode, guardrails, cost governance, and tool administration.

## Read order

1. `docs/PHASE_1_BUILD_BRIEF.md`
2. `docs/ARCHITECTURE_TARGET.md`
3. `docs/CODE_REVIEW_PLAN.md`
4. `docs/ACCEPTANCE_CHECKLIST.md`
5. `docs/CURSOR_PROMPT.md`
6. `docs/KNOWN_FAILURES.md`
7. `docs/TOOL_POLICY_AND_ADMIN.md`
8. `docs/WARRANTY_GUARD.md`
9. `docs/COST_GOVERNANCE.md`

## Immediate production blockers

- Magic Mike must not inherit or mention Odoo in consumer customer mode.
- Production chat must always run public presenter and retail output guard.
- Phone-call mode must behave like a live phone call: one click, mic stays open, final transcript auto-sends, Magic Mike replies while streaming, ElevenLabs audio plays, user can interrupt.
- Voice selector and selected voice persistence must be fixed.
- Warranty process/coverage must be routed and guarded; do not dump manual/RAG summaries into customer chat.
- HubTiger must be surfaced as a GhostDash tool with read-only test console first.

## Review target

When code is pushed here, review starts with:

```text
1. runtime routing
2. tool policy isolation
3. cache/memory contamination
4. production presenter/output guard
5. phone-call state machine
6. STT/TTS websocket lifecycle
7. admin tool controls
8. tests and observability
```
