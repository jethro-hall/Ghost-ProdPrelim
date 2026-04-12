# Phase 1 Shared Chat Control Plane

Date: 2026-04-09

## Goal

Make `ghost_chatui` behave as a GhostDASH extension instead of a separate runtime owner, while cleaning up the GhostDASH connection model enough to support multiple LLM connections without scattering provider strings and ad hoc fields across the app.

## What Changed

### 1. Shared backend bootstrap contract

Added `GET /api/chat/bootstrap` so both chat surfaces can start from one control-plane contract.

Bootstrap now returns:

- default agent id
- runtime defaults
- connection-aware runtime summary
- capabilities
- feature flags for what the surface is allowed to override
- agent/runtime data

### 2. Connection metadata foundation

Extended connection records with:

- `provider_kind`
- `auth_strategy`
- `auth_header_name`

This keeps credentials and transport in one place while allowing:

- OpenAI
- OpenAI-compatible/self-hosted endpoints
- Anthropic-shaped records
- Gemini-shaped records

without inventing a separate connection-string field model for every provider.

### 3. Runtime profile connection binding

Added optional `connection_id` support inside runtime profile `llm_config`.

Current behavior:

- runtime profiles can bind to a saved connection directly
- legacy `provider` fallback still works
- agent pages can bind to a specific saved connection without moving model ownership out of the runtime profile

### 4. GhostDASH operator UI cleanup

Updated the GhostDASH connection/admin surfaces so operators can see and edit:

- provider kind
- auth strategy
- custom auth header when needed

Updated runtime-facing views so connection summaries are visible in:

- runtime defaults API
- dashboard summary cards
- connections page cards

Updated agent configuration so the runtime profile binds to a saved connection record instead of only a loose provider key.

### 5. Ghost ChatUI integration shift

`ghost_chatui` now:

- boots from `/api/chat/bootstrap?surface=ghost_chatui`
- uses GhostDASH-managed agent/runtime data
- disables mock/provider override controls in production
- hides roadmap/internal harness sections unless dev-style controls are actually available
- avoids pre-hydration mock-agent flashes by starting from a neutral waiting state

### 6. Compose drift repair

Found and repaired a production drift issue in `docker-compose.yml`.

Before repair, compose was still forcing legacy values:

- `ghostdash_knowledge`
- `text-embedding-3-small`
- `gpt-5.4`

After repair, compose now aligns with the repo’s intended defaults:

- `APP_QDRANT_COLLECTION=ghostdash_knowledge_e5_v1`
- `APP_QDRANT_VECTOR_SIZE=1024`
- `APP_DEFAULT_EMBEDDING_MODEL=openai/intfloat/multilingual-e5-large-instruct`
- `OPENAI_MODEL=openai/llama31-8b`

This removed the live `Qdrant collection 'ghostdash_knowledge' is configured for 1536-d vectors...` failure path that was still breaking `/chat`.

## Validation

### Automated

- Focused backend tests passed:
  - `tests/test_connections_and_bootstrap.py`
  - `tests/test_embedding_cache.py`
  - `tests/test_runtime_profiles.py`

### Deployment

- Rebuilt and restarted:
  - `workflow-runtime`
  - `control-api`
  - `agent-ingress`
  - `ui`
  - `ghost-chatui`

### Live API checks

Verified live:

- `/api/chat/bootstrap`
- `/api/connections`
- `/api/runtime/defaults`
- `/agent/chat`

After the compose fix, `/agent/chat` returned a grounded answer payload successfully instead of failing with the Qdrant vector mismatch.

## Residual Issues

### 1. `/chat` still fails the strict smoke prompt expectation

Transport is fixed and the stream returns `200`, but a human smoke test using `Reply with exactly CHAT_OK` still produced a timeout-style grounded fallback answer instead of the literal requested text.

This is no longer a bootstrap, connection, or vector-store outage.
It is now an application/runtime behavior issue:

- the prompt is still being routed through the grounded retrieval workflow
- the active agent/system behavior prefers a long-form grounded answer path
- the current model/runtime path can still time out or fall back on some requests

This should be handled as a separate runtime-answering pass, not by reintroducing config drift.

### 2. `/agent` first-render polish

Initial empty-state flicker was reduced by converting the page to explicit loading states, but this should still be checked again by a human after normal browser cache/session conditions.

### 3. Ghost ChatUI production content hygiene

The surface no longer visibly boots into mock mode, but existing saved test conversations remain real data. If those titles are undesirable in production, they should be cleaned deliberately as data, not hidden in UI logic.

## Acceptance Criteria

- GhostDASH exposes provider kind and auth strategy on connection/operator surfaces.
- Agent configuration binds to saved connections while keeping model ownership in runtime profiles.
- `ghost_chatui` boots from GhostDASH-managed bootstrap/runtime data and does not expose production mock controls.
- Live `/chat` no longer fails because of Qdrant vector-size drift.

## Exact Verify Commands

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'
curl -sS http://localhost/api/chat/bootstrap?surface=ghost_chatui
curl -sS http://localhost/api/connections
curl -sS http://localhost/api/runtime/defaults
curl -sS -X POST http://localhost/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Reply with exactly CHAT_OK","agent_id":"2564d0e0-4cf3-4dab-8e78-91c6e4daf9cc","api_mode":"chat_completions"}'
```

### Human verification

1. Open `https://ghoststack.rideai.com.au/connections`
2. Confirm provider cards and the manage-provider panel show `Provider kind` and `Auth`
3. Open `https://ghoststack.rideai.com.au/agent`
4. Confirm the provider selector loads saved connections after the loading state
5. Open `https://ghoststack.rideai.com.au/ghost_chatui`
6. Confirm no visible mock-provider boot state appears and the surface reads as a GhostDASH extension
7. Open `https://ghoststack.rideai.com.au/chat`
8. Send a simple message and confirm the app now responds from the repaired runtime path
