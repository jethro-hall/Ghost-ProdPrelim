# HubTiger ElevenLabs Workflow Template (2026-04-30)

## Requirement

Provide workflow-style HubTiger tool usage suitable for ElevenLabs voice agents, aligned with GhostDASH runtime behavior.

## Root Cause

Existing docs described per-function behavior but did not provide a concise, copy-ready workflow sequence for ElevenLabs prompt and tool invocation order.

## Correct Layer

- Operator/agent guidance docs layer (`docs/HUBTIGER_OPERATOR_PLAYBOOK.md`)

## Existing Components Reused

- Canonical endpoint: `POST /api/elevenlabs/hubtiger/tool`
- Canonical function map already implemented in control-api adapter and MCP routing
- Existing Magic Mike tool sequencing rules

## Change Implemented

Added `ElevenLabs Workflow Tool Usage (Ready Template)` section to:

- `docs/HUBTIGER_OPERATOR_PLAYBOOK.md`

Section includes:

1. Shared endpoint contract
2. State-machine style workflow
3. Existing job two-step flow (`job_search` -> `job_retrieve`)
4. Booking flow (`booking_availability` -> `booking_create`)
5. Quote flow (`quote_preview` -> `quote_add_line_item`)
6. Fail-closed and public-safe output rules
7. Copy/paste prompt block for ElevenLabs agent instructions

## Why This Is Not A One-Off

The template enforces deterministic sequencing and evidence-first response behavior across all HubTiger voice flows, reducing future drift between prompts, runtime adapter behavior, and MCP routing.

## Token/Resource Impact

- Reduces unnecessary turns by requiring minimum-field collection and one-tool-at-a-time execution.
- Reduces retries by explicitly defining operation order.

## Cleanup

- No code-path cleanup required for this docs-only change.
- Follow-up recommended: remove legacy `job_lookup` examples from any old onboarding notes once migration to explicit `job_search`/`job_retrieve` is complete.

## Tests / Proof

Docs change only; no runtime code modified.

Verification commands:

```bash
rg "ElevenLabs Workflow Tool Usage \\(Ready Template\\)" docs/HUBTIGER_OPERATOR_PLAYBOOK.md
rg "\"function\": \"job_search\"|\"function\": \"job_retrieve\"|\"function\": \"booking_availability\"|\"function\": \"quote_preview\"" docs/HUBTIGER_OPERATOR_PLAYBOOK.md
```

## Human QA Checklist

1. Open `docs/HUBTIGER_OPERATOR_PLAYBOOK.md`.
2. Confirm the new ElevenLabs section appears after function map.
3. Validate each workflow step references existing canonical function names.
4. Confirm fallback wording avoids internal diagnostics and keeps one clear next step.
5. Confirm prompt block is copy/paste friendly for ElevenLabs agent configuration.
