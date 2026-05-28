# Chat Analysis Modes + Working Session Review

## Objective

Implement the board-level chat behavior discussed for GhostDASH so the product can explicitly switch between:

- `Quick`
- `Board`
- `Working Session`

The target user problem was finance-heavy Odoo chat that previously defaulted to a thin staged first answer, even when the user wanted a board-grade or coached-through analysis.

## What shipped

### 1. Explicit chat mode contract

Added a first-class `conversation_mode` contract through:

- backend request/response schema
- streaming SSE payloads
- UI API types
- full-page `/chat` surface
- embedded `GhostChat` widget

Supported values:

- `quick`
- `board`
- `working_session`

### 2. Canonical persistence path

Final ownership is split cleanly by intent:

- runtime default owner: `runtime_profiles.guardrails_config_json.conversation_mode`
- per-conversation owner: `agent_conversations.conversation_mode`
- per-message audit trail: `agent_messages.conversation_mode`

That gives GhostDASH:

- a default mode for new chats
- a persisted selected mode for an active conversation
- replayable message history with the mode that produced the answer

Startup schema migration support was added for the new conversation/message columns.

### 3. Working Session behavior

The old finance behavior hardcoded a staged first answer ending with a drill-down invitation for every `odoo.finance.*` operation.

That is now mode-aware:

- `Quick`: keeps concise staged finance output
- `Board`: asks for a full executive first-pass answer
- `Working Session`: asks for a developed analyst-style first pass without the old staged suffix

The mode is also injected into:

- runtime context
- cache identity
- effective response snapshot identity
- effective system prompt

This prevents answer-style leakage across modes.

### 4. Finance workflow improvement

The workflow planner now understands named-business YTD performance questions such as:

- `Retail`
- `Burleigh`
- `Brisbane`
- `year so far`
- `YTD`
- `who is the performer`

For those prompts, the system now:

1. resolves named companies via `res.company`
2. maps them to canonical Odoo company IDs
3. executes `odoo.finance.margin.monthly_comparison`
4. feeds verified evidence into the final answer

This materially improves first-pass quality for board-style finance prompts.

### 5. Chat surface parity fix

A real product issue surfaced during browser QA:

- the full `/chat` page had the new mode selector
- the embedded `GhostChat` widget still used the old interaction model

That parity gap was fixed. Both chat surfaces now expose:

- `Quick`
- `Board`
- `Working Session`

## Files changed

### Backend

- `backend/src/ghostdash_api/agent_ingress.py`
- `backend/src/ghostdash_api/agent_memory.py`
- `backend/src/ghostdash_api/control_api.py`
- `backend/src/ghostdash_api/models.py`
- `backend/src/ghostdash_api/runtime_defaults.py`
- `backend/src/ghostdash_api/runtime_profiles.py`
- `backend/src/ghostdash_api/schema_migrations.py`
- `backend/src/ghostdash_api/schemas.py`
- `backend/src/ghostdash_api/workflows.py`

### UI

- `ui/src/api.ts`
- `ui/src/hooks/useChatEngine.ts`
- `ui/src/pages/chat/ChatPage.tsx`
- `ui/src/pages/chat/ChatArea.tsx`
- `ui/src/pages/chat/ChatComposer.tsx`
- `ui/src/components/GhostChat.tsx`
- `ui/src/pages/AgentConfigPage.tsx`

### Tests

- `backend/tests/test_agent_ingress_prompt_hotfix.py`
- `backend/tests/test_runtime_profiles.py`
- `backend/tests/test_tools_api.py`
- `backend/tests/test_workflows_odoo_planning.py`

## Architecture notes

### Why this is fit for purpose

- `query_mode` remains retrieval classification only and was not overloaded
- mode selection is explicit and user-driven
- mode-specific answer shaping is no longer invisible product behavior
- Odoo-backed finance comparison now has a concrete name-resolution path instead of leaving the model to guess

### Remaining design truth

There are still two chat surfaces in the app:

- full-page `/chat`
- embedded `GhostChat`

They are now feature-parity aligned for this change, but the code paths remain duplicated. That is a future simplification candidate. The highest-value follow-up would be consolidating both surfaces onto one shared orchestration path instead of maintaining two separate UI implementations.

## Testing performed

### Automated backend tests

Passed:

```bash
python3.12 -m pytest -q backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_agent_memory_tool_history.py backend/tests/test_workflows_odoo_planning.py backend/tests/test_runtime_profiles.py backend/tests/test_tools_api.py
```

Result:

- `33 passed`

### UI checks

Passed:

```bash
npx pnpm lint
```

Notes:

- `pnpm` was not globally available on this host, so `npx pnpm` was used
- direct local `vite build` to the default `dist/` failed because the existing `ui/dist` directory is permission-protected on this machine
- a clean alternate output build succeeded:

```bash
npx pnpm exec vite build --outDir dist-agent
```

- the Docker UI build also succeeded during `docker compose up -d --build`

### Human-style browser QA

Validated against the rebuilt live app at:

- `https://ghoststack.rideai.com.au/chat`
- `https://ghoststack.rideai.com.au/agent`

Observed:

- the full `/chat` page shows `Quick`, `Board`, and `Working Session`
- `Working Session` was selectable
- the finance prompt completed with verified Odoo evidence chips:
  - `odoo.rpc.search_read`
  - `odoo.finance.margin.monthly_comparison`
- browser search found no `Say CONTINUE` text in the resulting answer
- the answer included a developed analysis with uncertainty and next drill-down recommendations
- after the parity fix, the embedded `GhostChat` widget on `/agent` also showed:
  - `Quick`
  - `Board`
  - `Working Session`

Console observations:

- only standard Cursor browser warning entries about non-blocking dialog overrides
- no app-specific console error surfaced during the validated path

## Stack reality captured

Actual container names in this repo/runtime after rebuild:

- `ghoststack-rag-ui-1`
- `ghoststack-rag-agent-ingress-1`
- `ghoststack-rag-control-api-1`
- `ghoststack-rag-workflow-runtime-1`
- `ghoststack-rag-ghost-chatui-1`
- `ghoststack-rag-caddy-1`
- `ghoststack-rag-qdrant-1`
- `ghoststack-rag-postgres-1`

This implementation and review intentionally used the real stack names above instead of stale external names like `ghost-edge-gateway` or `ghost-control-plane`.

## Acceptance criteria

- explicit chat analysis mode exists in UI and backend contract
- mode is persisted per conversation and restored on reload
- `Working Session` no longer forces the old staged finance `CONTINUE` behavior
- named-business YTD finance questions route through verified Odoo company resolution plus finance comparison
- `/chat` and embedded `GhostChat` both expose the same mode selector
- cache identity separates answer style by mode

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag && git status -sb
```

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

```bash
python3.12 -m pytest -q backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_agent_memory_tool_history.py backend/tests/test_workflows_odoo_planning.py backend/tests/test_runtime_profiles.py backend/tests/test_tools_api.py
```

```bash
cd /var/llamaindex/ghoststack-rag/ui && npx pnpm lint
```

```bash
cd /var/llamaindex/ghoststack-rag/ui && npx pnpm exec vite build --outDir dist-agent
```

```bash
cd /var/llamaindex/ghoststack-rag && docker compose up -d --build control-api agent-ingress workflow-runtime ui
```

```bash
docker logs --tail=120 ghoststack-rag-agent-ingress-1
docker logs --tail=120 ghoststack-rag-workflow-runtime-1
```

```bash
AGENT_ID="$(curl -fsS https://ghoststack.rideai.com.au/api/agents | jq -r '.[] | select(.is_default==true) | .id' | head -n1)"
curl -fsS -X POST https://ghoststack.rideai.com.au/agent/chat \
  -H 'content-type: application/json' \
  -d "{
    \"agent_id\":\"${AGENT_ID}\",
    \"message\":\"Across the 3x main business Retail, Burleigh, Brisbane break down the year so far and who is the performer?\",
    \"corpora\":[\"re-finance26\"],
    \"api_mode\":\"responses\",
    \"conversation_mode\":\"working_session\"
  }" | jq '{conversation_mode,query_mode,answer,tool_events}'
```

## Recommended next step

Unify `/chat` and embedded `GhostChat` onto a single shared UI/orchestration implementation so future chat features do not need to be patched twice.
