# Provider Delete Phase 2 Modal (2026-04-17)

## Goal

Upgrade provider deletion UX from a browser `confirm()` prompt to a structured, human-readable modal that shows blockers and blast radius before execution.

## Delivered

- Replaced plain confirm flow with a dedicated modal in `RightPanel`.
- Modal displays:
  - Provider identity (`label`, `provider`)
  - Blocker reasons (if present)
  - Blast-radius counters from deletion preview payload
  - Explicit destructive button (`Delete provider now`) gated by `can_execute`
- Modal supports cancel/close without side effects.

## Safety Behavior

- Delete action still fetches backend preview first.
- If preview is blocked, modal shows reasons and disables destructive action.
- If preview is executable, user must explicitly click `Delete provider now`.
- Backend confirmation token flow remains unchanged.

## File Updated

- `ui/src/components/RightPanel.tsx`

## Verification

- IDE lint check on touched UI file: clean.
- Modal state reset added on connection form hydration to prevent stale deletion context when switching providers.
