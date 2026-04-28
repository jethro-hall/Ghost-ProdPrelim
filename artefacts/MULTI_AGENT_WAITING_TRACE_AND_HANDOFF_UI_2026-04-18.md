# Multi-Agent Waiting Trace and Handoff UX (2026-04-18)

## Objective

Make orchestrated chat responses visibly show:
- sub-agent dispatch
- waiting states
- sub-agent completion
- final response synthesis

This enables an operator-visible "Finance Analyst -> Documenter -> final output" flow.

## Changes implemented

### Backend stream orchestration telemetry

File:
- `backend/src/ghostdash_api/agent_ingress.py`

Added:
- `MULTI_AGENT_HANDOFF_DELAY_SECONDS = 0.85`
- `_should_emit_multi_agent_handoff_trace(...)`
- `_build_multi_agent_handoff_events(...)`

Behavior:
- For worker-routed turns (especially Odoo-finance workflows), stream now emits staged `tool_result` events:
  1. `agent.finance_analyst` planned
  2. `agent.finance_analyst` executed
  3. `agent.business_documenter` planned
  4. `agent.business_documenter` executed
- Planned states include an intentional short delay (`0.85s`) so the operator can see “waiting” progression.
- Handoff events are appended to persisted `tool_events` for the assistant turn.

### Route metadata enrichment

File:
- `backend/src/ghostdash_api/agent_ingress.py`

Behavior:
- `build_route_decision(...)` now returns `recommended_workers` for worker routes:
  - `finance_analyst`
  - `business_documenter`

### UI waiting/spinner rendering

File:
- `ui/src/components/chat/AgentToolTrace.tsx`

Behavior:
- Added friendly labels for synthetic sub-agent tool ids:
  - `agent.finance_analyst` -> `Finance Analyst`
  - `agent.business_documenter` -> `Business Documenter`
- Planned status chip now renders an animated spinner.
- If a planned event has no summary, UI shows `Waiting for sub-agent response…`.

### Test updates

File:
- `backend/tests/test_agent_ingress_prompt_hotfix.py`

Updated one stream-order assertion to support additional orchestration events while still verifying:
- stream starts and ends correctly
- Odoo execution event appears
- assistant delta is emitted
- final done payload includes executed tool events

## Verification

Executed:
- `pytest backend/tests/test_agent_ingress_prompt_hotfix.py -q`

Result:
- `14 passed`

Lints:
- No diagnostics in changed backend/UI files.

## Operator-visible outcome

During worker-style finance requests, chat now visibly shows:
1. Finance Analyst call + waiting
2. Finance Analyst completion
3. Documenter handoff + waiting
4. Documenter completion
5. Final assistant output

