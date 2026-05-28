# BP Mode Model Failover + Grounding Recovery (2026-04-22)

## Objective
Stop BP mode from collapsing into placeholder/fallback-only output by:
- forcing unsupported BP runtime model IDs onto a known-valid runtime default; and
- preserving grounded branch KPIs in provisional output instead of blanking every KPI.

## Root Cause
1. BP chain runtime profiles were pinned to unsupported model IDs (`gpt-5.4`, `gpt-5.4-nano`, and fallback `gpt-5.2-pro`) in this environment, causing generation instability.
2. BP provisional formatter required complete grounding for all requested KPI pairs; if one KPI was missing (for example ROAS), it rendered every KPI as `Not grounded`, hiding valid Odoo P&L values.

## Changes Implemented

### 1) Runtime model repair hardening
File: `backend/src/ghostdash_api/agent_memory.py`
- BP replacement model now uses `settings.app_default_chat_model` (runtime default currently `openai/llama31-8b`), not a hardcoded GPT id.
- Expanded unsupported BP model set:
  - `gpt-5.2-pro`, `openai/gpt-5.2-pro`
  - `gpt-5.4`, `openai/gpt-5.4`
  - `gpt-5.4-nano`, `openai/gpt-5.4-nano`
- During BP runtime profile repair, unsupported `llm_orchestration.fallback_model_id` is nulled so stale fallback IDs cannot reintroduce invalid models.

### 2) Provisional KPI preservation
File: `backend/src/ghostdash_api/agent_ingress.py`
- Expanded BP metric extraction aliases for Odoo P&L rows:
  - Revenue: includes `total_income`
  - COGS: includes `cost_of_sales`
  - Net: includes `net_income`
  - Added ad-spend aliases and derived ROAS when revenue + ad spend exist
- BP missing-grounding response now:
  - preserves grounded KPI values per branch;
  - marks only missing KPI pairs as `Missing`;
  - emits comparison signals for available KPI pairs.

## Test Evidence
File: `backend/tests/test_agent_ingress_prompt_hotfix.py`
- Added `test_build_bp_missing_grounding_response_preserves_grounded_pairs`
  - validates grounded REV/COGS/GP/NET render as currency;
  - validates ROAS remains `Not grounded` when absent;
  - validates comparison signal text exists.

Command run:
- `pytest backend/tests/test_agent_ingress_prompt_hotfix.py -k "missing_grounding_response_preserves_grounded_pairs or synthetic_placeholder_finance_output or empty_model_fallback_for_finance_output"`
- Result: `3 passed`

## Deployment / Runtime Verification
- Rebuilt and restarted `agent-ingress` and `control-api`.
- Service health after deploy:
  - `ghoststack-rag-agent-ingress-1`: healthy
  - `ghoststack-rag-control-api-1`: healthy
  - `ghoststack-rag-workflow-runtime-1`: healthy

## Current Risk
- Browser UI intermittently remains in `Stop generating` state even when ingress completes `/agent/chat/stream` successfully in ~2.6s.
- This is now the primary blocker for clean human-visible confirmation in-chat, separate from model-id failure.
