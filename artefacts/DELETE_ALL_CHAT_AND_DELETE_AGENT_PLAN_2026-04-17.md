# Delete All Chat + Delete Agent Plan (2026-04-17)

## Objective

Add two safe destructive operations to GhostDASH:

1. **Delete All Chat** for a selected agent.
2. **Delete Agent** with strong safety rails and integrity guarantees.

This plan is architecture-led to avoid orphaned data, accidental default-agent breakage, or seed-driven re-creation surprises.

## Evidence captured before planning

- `git status -sb`: repo is dirty and ahead of remote; plan must isolate changes to deletion scope only.
- `docker ps`: stack healthy (`ghoststack-rag-agent-ingress-1`, `ghoststack-rag-control-api-1`, etc.).
- Requested logs:
  - use active containers in this environment: `ghoststack-rag-caddy-1` and `ghoststack-rag-control-api-1`.
  - keep `agent-ingress` logs for orchestration-specific diagnostics.
- Current code state:
  - no delete endpoints for agents/conversations in control API
  - list/create APIs exist for agents and conversations
  - DB model links are largely logical IDs; deletion integrity must be explicit.

## Architecture decisions

### A) API contract (two-step destructive flow)

Add **preview first**, then execute:

1. `POST /api/agents/{agent_id}/deletion-preview`
   - Request: `{ "scope": "chats" | "agent" }`
   - Returns:
     - `can_execute`
     - `blocking_reasons[]`
     - per-table impact counts
     - policy decisions (what will be deleted vs retained)
     - short-lived `confirmation_token`

2. `DELETE /api/agents/{agent_id}/conversations` (Delete All Chat)
   - Requires:
     - `confirm=true`
     - `confirmation_token`
     - `Idempotency-Key` header
   - Returns operation summary (or async `operation_id` if needed).

3. `DELETE /api/agents/{agent_id}` (Delete Agent)
   - Requires:
     - `confirm=true`
     - `cascade=true`
     - `confirmation_token`
     - `Idempotency-Key`
   - Blocks by default if agent is default/protected or in active workflow context.

### B) Deletion semantics

- **Delete All Chat**
  - Delete conversations + dependent chat artifacts for that agent.
  - Keep agent profile and runtime profile.

- **Delete Agent**
  - Run `Delete All Chat` semantics first.
  - Then delete/disable agent profile.
  - Runtime profile handling:
    - if shared/referenced by other agents: keep
    - if unreferenced and not default: safe delete or disable.

### C) Safety guardrails

- default agent protection (hard block unless explicit replacement flow added).
- mandatory preview + confirmation token.
- idempotency key required for destructive calls.
- optional async worker mode if row volume is large.
- explicit transaction boundaries and ordering to prevent partial deletes.

### D) Seed interaction protection

`seed_default_agent_profiles()` can recreate expected agents on startup. Deletion plan must account for this:

- default seeded assistant should be protected from direct deletion in v1.
- non-default special agents should support deletion without reseed resurrection (either:
  - seed logic skip-tombstoned names, or
  - only guarantee seeded defaults are recreated by design and make this explicit in UX).

## Data integrity risk controls

Top controls required:

1. delete ordering child-first (messages/uploads/docx/cache before conversations/agent).
2. no dangling references to deleted conversations/agents.
3. workflow run/step references checked before agent delete.
4. document/vector ownership policy explicit:
   - chat-only uploads deleted,
   - promoted knowledge docs retained unless explicitly requested.
5. post-delete reconciliation queries in CI/manual verify.

## Implementation phases

### Phase 1 - Preview + policy scaffolding

- Add preview endpoint and impact calculator.
- Include blockers:
  - default agent
  - active workflow references
  - invalid/missing agent

### Phase 2 - Delete All Chat endpoint

- Add service function in backend memory/control layer.
- Delete in deterministic order:
  - message-like dependents
  - upload/docx/cache references
  - conversations
- Add API + UI action in chat sidebar/agent area.

### Phase 3 - Delete Agent endpoint

- Add deletion service with:
  - guardrails
  - cascade logic
  - runtime profile reference checks
- Add UI action in agent management page with strong confirmation UX.

### Phase 4 - Hardening + observability

- structured delete operation logs
- operation summary object in response
- metrics counters by scope/status
- regression tests for no-orphan guarantees.

## Testing strategy

### Unit

- preview impact math
- blocker logic (default agent, active workflows)
- delete ordering and idempotency behavior
- runtime profile cleanup decisions

### Integration

- create agent + conversations + uploads + messages -> delete all chat -> assert zero conversations and no orphans
- delete non-default agent -> assert agent removed and no cross-table residue
- attempt to delete default agent -> assert blocked
- repeated request with same idempotency key -> stable no-op behavior

### Human QA

- verify UI confirmation flow prevents accidental destructive click
- verify list refreshes immediately after delete
- verify surviving agents and active chat context remain stable

## Acceptance criteria

1. `Delete All Chat` removes all conversations and chat dependents for one agent without orphan rows.
2. `Delete Agent` removes (or safely disables) target agent and related chat data while preserving platform stability.
3. Default/protected agent cannot be deleted through normal flow.
4. No destructive operation runs without preview + confirmation token + idempotency key.
5. Re-running same delete request is safe and deterministic.
6. UI reflects completion state correctly and does not break active session routing.

## Exact verify commands

Environment checks:

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-caddy-1
docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-agent-ingress-1
```

Post-implementation API checks (example flow):

```bash
export API="http://localhost"
export AGENT_ID="<agent-id>"
export IDEMPOTENCY_KEY="$(uuidgen)"
```

```bash
curl -sS -X POST "$API/api/agents/$AGENT_ID/deletion-preview" \
  -H "Content-Type: application/json" \
  -d '{"scope":"chats"}'
```

```bash
curl -sS -X DELETE "$API/api/agents/$AGENT_ID/conversations?confirm=true" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"confirmation_token":"<token-from-preview>"}'
```

```bash
curl -sS -X POST "$API/api/agents/$AGENT_ID/deletion-preview" \
  -H "Content-Type: application/json" \
  -d '{"scope":"agent"}'
```

```bash
curl -sS -X DELETE "$API/api/agents/$AGENT_ID?confirm=true&cascade=true" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"confirmation_token":"<token-from-preview>"}'
```

DB integrity checks (example expected zero-orphan assertions; adapt DSN/schema):

```bash
docker exec -e PGPASSWORD=ghostdash ghoststack-rag-postgres-1 psql -U ghostdash -d ghostdash -c "
SELECT count(*) AS orphan_messages
FROM agent_messages m
LEFT JOIN agent_conversations c ON c.id = m.conversation_id
WHERE c.id IS NULL;
"
```
