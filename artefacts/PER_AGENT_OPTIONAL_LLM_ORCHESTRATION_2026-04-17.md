# Per-Agent Optional LLM Orchestration (2026-04-17)

## Goal

Implement a dynamic, per-agent optional multi-LLM orchestration mode in GhostDASH without changing existing default runtime behavior.

## Single Source Of Truth

- **Owner:** runtime profile LLM config (`runtime_profiles.llm_config_json`)
- **Canonical API:** existing agent/runtime profile surfaces (`/api/agents`, `/api/chat/bootstrap`)
- **Canonical UI editor:** `AgentConfigPage` Generation section
- **Read path:** `agent_ingress` resolves runtime profile once and uses `llm_config.llm_orchestration`

No duplicated settings table or shadow config was introduced.

## New runtime config contract

Location: `llm_config.llm_orchestration`

- `enabled` (bool, default `false`)
- `trigger_mode` (`on_prompt_overflow` | `always_second_pass`)
- `prompt_token_soft_limit` (optional int)
- `fallback_connection_id` (optional string)
- `fallback_provider` (string, default `openai`)
- `fallback_model_id` (optional string)
- `include_primary_answer_context` (bool, default `true`)

## Behavior design

### Default path

When `enabled=false`, behavior is unchanged from prior implementation.

### Orchestrated path

When enabled:

1. Primary model runs with existing guardrails/system prompt.
2. Trigger check decides second pass:
   - overflow/context guardrail
   - explicit prompt soft-limit breach
   - always-second-pass mode
3. Optional fallback model run executes with:
   - same system prompt / guardrails
   - same API mode
   - optional primary-answer context injection

## Chat observability

Every assistant response now carries route decision execution details:

- `route_decision.llm_execution[]` with per-step:
  - stage (`primary`/`secondary`)
  - model
  - provider/connection label
  - in/out/total tokens
  - reason

UI now renders this trace in assistant messages so operators can verify which LLM did which work.

## Token accounting

Usage totals now aggregate across orchestration steps when multi-pass is active.

Stream output `llm_io` now includes:

- total in/out/total (aggregated usage)
- first prompt excerpt (first LLM touchpoint)
- last prompt excerpt (final LLM touchpoint)

## Files changed

- Backend:
  - `backend/src/ghostdash_api/schemas.py`
  - `backend/src/ghostdash_api/runtime_profiles.py`
  - `backend/src/ghostdash_api/agent_ingress.py`
- UI:
  - `ui/src/api.ts`
  - `ui/src/pages/AgentConfigPage.tsx`
  - `ui/src/pages/chat/MessageList.tsx`
  - `ui/src/components/GhostChat.tsx`

## Verification

- `pytest backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_runtime_profiles.py` -> pass
- `./ui/node_modules/.bin/tsc --noEmit -p ui/tsconfig.json` -> pass

## Risks and mitigations

- **Risk:** misconfigured fallback connection/model.
  - **Mitigation:** feature is opt-in and errors are logged with `chat_*second_pass.failed`; primary path remains intact.
- **Risk:** token counts become ambiguous in multi-pass.
  - **Mitigation:** explicit per-step execution + aggregated totals.
