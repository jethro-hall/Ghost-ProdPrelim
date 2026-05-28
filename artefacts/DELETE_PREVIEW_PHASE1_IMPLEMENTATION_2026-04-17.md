# Delete Preview Phase 1 Implementation (2026-04-17)

## Goal
Ship a safe, non-destructive preflight endpoint for agent deletion workflows so UI and operators can inspect impact and blockers before any data is removed.

## Scope Delivered
- Added `POST /api/agents/{agent_id}/deletion-preview` endpoint in control API.
- Added typed request/response contracts for deletion preview.
- Added blocker detection for:
  - default-agent protection (`scope=agent`)
  - active workflow runs
  - active workflow steps
- Added impact counts for related records:
  - conversations, messages, uploads, docx sessions, cache entries, workflow step runs
  - linked document frames and orphanable frame estimate
  - active workflow references
  - peer agents sharing runtime profile (agent scope)
- Added deterministic confirmation token generation from preview payload snapshot.
- Added regression tests for counts and blocker semantics.

## Files Changed
- `backend/src/ghostdash_api/schemas.py`
  - `DeletionPreviewScope`
  - `AgentDeletionPreviewPayload`
  - `AgentDeletionPreviewImpactView`
  - `AgentDeletionPreviewView`
- `backend/src/ghostdash_api/control_api.py`
  - `api_agent_deletion_preview` route
  - `_build_agent_deletion_preview` preflight calculator
  - workflow activity helpers/constants
- `backend/tests/test_agent_deletion_preview.py`
  - coverage for:
    - normal chat-scope impact count
    - default-agent block in agent-scope
    - active workflow run/step blockers

## Safety Notes
- No destructive behavior added in this phase.
- Endpoint is read-only and idempotent.
- Blocker signals are explicit and machine-readable for UI gating.

## Known Limitations
- No execution endpoints yet (`delete chats` / `delete agent`) and no DB transaction deletion path in this phase.
- Confirmation token is preview-state based and currently not validated by an execution endpoint yet.

## Verification
- Automated:
  - `pytest -q tests/test_agent_deletion_preview.py`
- Runtime diagnostics snapshot:
  - `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
  - Use active diagnostics containers in this environment: `ghoststack-rag-caddy-1` and `ghoststack-rag-control-api-1`.

## Next Phase (Recommended)
1. Implement `DELETE /api/agents/{agent_id}/conversations` with confirmation token + dry-run support.
2. Add async worker path for large deletions and operation status endpoint.
3. Implement `DELETE /api/agents/{agent_id}` with strict blocker policy and default-agent guardrails.
4. Add end-to-end UI flow with human confirmation modal and explicit blast-radius rendering from preview payload.
