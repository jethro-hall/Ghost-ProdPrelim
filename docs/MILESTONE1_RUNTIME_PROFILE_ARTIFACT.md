# Milestone 1 Runtime Profile Artifact

## Goal

Make `control-plane-api` the real system of record for runtime behavior so GhostDASH no longer splits LLM, guardrail, knowledge-base, retrieval, and tool-policy settings across multiple owners.

## Canonical ownership

Milestone 1 now enforces this ownership model:

- `connections` owns provider transport only:
  - provider
  - label
  - base URL
  - API key
- `runtime_profiles` owns runtime behavior:
  - `llm_config`
  - `guardrails_config`
  - `kb_config`
  - `retrieval_config`
  - `tool_policy_config`
- `agent_profiles` owns agent identity and references one runtime profile through `runtime_profile_id`
- `GET /api/runtime/defaults` is now a compatibility view over the default runtime profile, not a second settings store

This removes the previous duplicated ownership where parts of runtime state lived in agent columns, connection records, and UI-local settings.

## Implemented backend structure

### New canonical record

Added `RuntimeProfileRecord` in `backend/src/ghostdash_api/models.py`.

This record now persists the full runtime envelope in one place:

- model/provider/API mode/sampling
- system prompt and insufficient-context behavior
- default corpora and embedding model
- retrieval defaults and parse-lane policy
- enabled tool list

### Runtime-profile logic

Added `backend/src/ghostdash_api/runtime_profiles.py` to centralize:

- default runtime-profile seeding
- runtime-profile serialization
- effective runtime-profile resolution for agents
- updating the compatibility defaults view

### Schema migration path

Added `backend/src/ghostdash_api/schema_migrations.py` to:

- create/backfill `runtime_profiles`
- add `agent_profiles.runtime_profile_id`
- migrate legacy agent/runtime data into runtime profiles
- drop legacy duplicate columns from `agent_profiles` and `connections`
- remove the old `runtime_defaults` table on Postgres

### API and runtime changes

Updated:

- `backend/src/ghostdash_api/control_api.py`
- `backend/src/ghostdash_api/runtime_defaults.py`
- `backend/src/ghostdash_api/runtime.py`
- `backend/src/ghostdash_api/agent_memory.py`
- `backend/src/ghostdash_api/workflows.py`
- `backend/src/ghostdash_api/schemas.py`

Operator-facing effect:

- agents are returned with their resolved runtime profile
- saving an agent can create or update its canonical runtime profile
- connection testing resolves the model from runtime-profile state instead of duplicated connection fields
- ingestion/query embedding defaults now come from the default runtime profile

## UI ownership after Milestone 1

### Single editable surfaces

- `ui/src/pages/PipelinesPage.tsx` is the only editable surface for:
  - default chat API mode
  - embedding model
  - default corpora
  - retrieval defaults
  - parse-lane policy
  - rerank default
- `ui/src/pages/AgentConfigPage.tsx` is the only editable surface for:
  - model
  - system prompt
  - insufficient-context behavior
  - tool policy

### Read-only mirrors

- `ui/src/pages/ConnectionsPage.tsx` now shows transport ownership only
- `ui/src/components/RightPanel.tsx` no longer edits model or API mode
- `ui/src/components/GhostChat.tsx` shows API mode as a badge, not a selector
- `ui/src/pages/Dashboard.tsx` reflects the effective runtime defaults pulled from the backend

## Acceptance criteria satisfied

- Creating and updating agent runtime state now persists through the canonical agent + runtime-profile API shape
- Runtime settings have one persistence owner: `runtime_profiles`
- Duplicate connection-level and agent-level runtime columns have been removed from the active design
- The dashboard reflects runtime-default changes saved through the canonical Pipelines editor
- Connections and GhostChat no longer expose duplicate editable runtime settings

## Verification performed

### Automated verification

- Focused backend tests passed for runtime-profile ownership:
  - `APP_DB_URL='sqlite:///:memory:' PYTHONPATH=src pytest tests/test_runtime_profiles.py`
- Frontend lint passed:
  - `npm run lint`
- Frontend production build passed using alternate output dir because the default `dist` path had a permission issue:
  - `npm run build -- --outDir dist-milestone1`

### Live stack verification

- Verified live container state with `docker ps`
- Verified the compatibility defaults API after the restore flow:
  - `chat_api_mode: "responses"`
  - `runtime_profile_name: "GhostDASH Default Runtime"`
- Verified the stack was serving through the local Caddy instance

### Human QA verification

Human-style walkthrough was completed against `https://ghoststack.rideai.com.au`, which terminates on the same running Caddy instance used by the local stack. The IDE browser could not reach its own `localhost`, so the domain route was used for the actual interaction test while shell verification confirmed the local API state.

Confirmed:

- Dashboard loads and resolves runtime summary cards
- Pipelines is the single editable runtime-defaults surface
- Changing `Chat API mode` to `Chat Completions API` saved successfully and the dashboard reflected the new mode
- Restoring `Chat API mode` to `Responses API` also saved successfully
- Connections no longer exposes editable chat-mode/model/embedding controls
- GhostChat displays API mode as a read-only badge
- Agent Config exposes model/system prompt/tool policy editing and explicitly delegates retrieval ownership to Pipelines

Observed note:

- The browser accessibility snapshot labels the Agent Config checkboxes as `readonly`, but manual interaction confirmed they do toggle in the UI. This was a tooling/snapshot quirk, not a product defect.

## Residual risk

- `GET /api/runtime/defaults` still exists as a compatibility contract. That is acceptable for Milestone 1, but future work should keep treating it strictly as a view over the default runtime profile rather than a second settings owner.
- The browser automation environment cannot directly hit its own `localhost`, so browser QA depends on the domain route when available.

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
curl -sS http://localhost/api/runtime/defaults
APP_DB_URL='sqlite:///:memory:' PYTHONPATH=src pytest tests/test_runtime_profiles.py
cd ui && npm run lint
cd ui && npm run build -- --outDir dist-milestone1
```

## Human retest request

Please retest these operator flows in the browser:

1. Open `Parsing Pipelines`, change `Chat API mode`, save, and confirm the dashboard runtime card updates.
2. Open `LLM Connections` and confirm model/API mode are informational only.
3. Open `GhostChat` and confirm API mode is displayed as a badge, not an editor.
4. Open `Agent Config` and confirm model/system prompt/tool toggles remain editable while retrieval ownership still points back to `Pipelines`.
