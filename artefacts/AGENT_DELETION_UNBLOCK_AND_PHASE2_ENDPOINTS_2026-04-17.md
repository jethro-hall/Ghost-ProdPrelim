# Agent Deletion Unblock + Phase 2 Endpoints (2026-04-17)

## Incident
User reported that agent deletion was blocked again.

## Root Cause
`active_workflow_steps` blocker logic counted pending/running `workflow_step_runs` even when the parent `workflow_run` was already terminal (for example `completed`). This produced false-positive blockers and prevented deletion.

## Fixes Implemented
- Tightened active-step blocker calculation to count only steps whose parent run is active (`queued`/`running`).
- Added destructive endpoints with explicit confirmation token + `confirm=true` guard:
  - `DELETE /api/agents/{agent_id}/conversations`
  - `DELETE /api/agents/{agent_id}`
- Added server-side deletion orchestration for agent-scoped chat data:
  - `agent_messages`
  - `chat_uploads`
  - `docx_sessions`
  - `workflow_step_runs` (conversation-linked and agent-linked)
  - `agent_conversations`
  - `chat_response_cache`
  - orphanable `document_frames`
- Added typed schemas:
  - `AgentDeletePayload`
  - `AgentDeleteResponse`

## Safety Guardrails
- Two-step flow required:
  1) `POST /api/agents/{agent_id}/deletion-preview`
  2) destructive `DELETE` with matching `confirmation_token` and `confirm=true`
- Default agent cannot be deleted (`scope=agent` preview blocker).
- Active workflow run/step blockers still enforced (now with accurate run-state gating).

## Verification
- `pytest -q tests/test_agent_deletion_preview.py` -> 5 passed
- `pytest -q tests/test_connections_and_bootstrap.py::test_chat_bootstrap_returns_shared_runtime_and_agents` -> 1 passed

## Human Test Plan
1. Preview `scope=agent` for a non-default agent with no active run; confirm `can_execute=true`.
2. Delete chats via `DELETE /api/agents/{id}/conversations?confirm=true`.
3. Re-run preview and then delete agent via `DELETE /api/agents/{id}?confirm=true`.
4. Try default agent delete; confirm blocked with `default_agent_protected`.
