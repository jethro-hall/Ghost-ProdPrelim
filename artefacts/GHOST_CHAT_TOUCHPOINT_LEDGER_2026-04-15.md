## Purpose
Record every major touch point for one Ghost Chat turn from UI state to provider call and back, using the current `/chat` stack as the canonical path.

## Canonical path
1. User selects an agent and enters a message in `ui/src/pages/chat/ChatPage.tsx`.
2. `useChatEngine()` in `ui/src/hooks/useChatEngine.ts` owns session state:
   - `activeAgentId`
   - `activeConversationId`
   - `sessionApiMode`
   - `sessionConversationMode`
   - `sessionWorkflowMode`
   - `useApprovedWeb`
3. `sendMessage()` in `ui/src/hooks/useChatEngine.ts` builds the outbound request for `streamChat()`.
4. `streamChat()` in `ui/src/api.ts` POSTs `/agent/chat/stream` with:
   - `message`
   - `corpora`
   - `api_mode`
   - `conversation_mode`
   - `workflow_mode`
   - `agent_id`
   - `conversation_id`
   - `use_approved_web`
   - `tool_overrides`
5. `/agent/chat/stream` in `backend/src/ghostdash_api/agent_ingress.py` resolves:
   - agent
   - runtime profile
   - corpora
   - conversation mode
   - workflow mode
   - effective system prompt
6. `agent_ingress.fetch_query_plan()` POSTs `/internal/query-plan` on `workflow-runtime` with:
   - prompt/query text
   - corpora
   - top_k
   - workflow_mode
   - `embedding_model_id`
   - `kb_enabled`
   - `odoo_ready`
7. `workflow_runtime` forwards into `build_query_plan()` in `backend/src/ghostdash_api/workflows.py`.
8. `build_query_plan()` decides:
   - retrieval mode
   - whether KB retrieval is allowed
   - whether Odoo should suppress retrieval
   - semantic/structured retrieval prompt bundle
9. Back in `agent_ingress`, `prepare_tool_evidence()` resolves Odoo execution status and emits concrete `ChatToolEvent` objects.
10. `runtime.generate_answer()` or `runtime.stream_answer()` in `backend/src/ghostdash_api/runtime.py` makes the final provider call.
11. `agent_ingress` persists:
   - user message
   - assistant message
   - citations
   - real `tool_events_json`
   - real `usage_json`
12. The SSE response returns:
   - `start`
   - zero or more `tool_result`
   - zero or more `delta`
   - `done`
13. `useChatEngine()` applies streamed state and then reloads conversation history from `/api/conversations/{id}/messages`.
14. The reloaded messages now carry persisted `tool_events` and `usage`, so the UI no longer needs to infer tool execution from citations.

## Source-of-truth matrix
### Agent/runtime fields
- `system_prompt`: runtime profile guardrails config in Postgres
- `model_id`: runtime profile llm config in Postgres
- `api_mode`: conversation request + runtime profile default
- `conversation_mode`: conversation request + runtime profile default
- `workflow_mode`: conversation request + conversation record

### Tool fields
- `kb.enabled`: runtime profile tool policy, enforced in `build_query_plan()`
- `web.enabled`: runtime profile tool policy + allowlist + explicit intent/use flag
- `odoo_primary.enabled`: runtime profile tool policy + tool registry readiness + per-turn override

### Token fields
- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
Stored on assistant messages as `usage_json`.
Provider-native when available at the final hop; estimated otherwise.

## Touch points that previously caused drift
- Session UI controls could override saved runtime behavior before send.
- `build_query_plan()` used the default runtime profile instead of the active agent’s KB config.
- UI history rehydration invented tool execution state from citations.
- Token usage only lived in transient sidebar state and was estimated after generation.

## What was repaired
- Assistant messages now persist `tool_events_json` and `usage_json`.
- UI history uses persisted tool events instead of reconstructing them from citations.
- Planner input now receives `embedding_model_id`, `kb_enabled`, and `odoo_ready`.
- KB and Odoo suppression logic is tied to the active agent/runtime state instead of default-profile fallbacks.

## Verify
```bash
rg -n "sendMessage|streamChat|fetch_query_plan|build_query_plan|prepare_tool_evidence|append_message" /var/llamaindex/ghoststack-rag/{ui/src,backend/src/ghostdash_api}
```

