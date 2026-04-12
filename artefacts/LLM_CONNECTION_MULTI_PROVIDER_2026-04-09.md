# LLM Connection Multi-Provider Enablement (2026-04-09)

## Objective
- Fix issue where UI/runtime effectively used only one LLM connection record.
- Add a dedicated UI section to add and manage additional LLM connections.
- Confirm end-to-end that a non-default provider key can be saved and selected by an agent runtime profile.

## Root Cause
- Connection management UI was hardcoded to only the `openai` provider.
- Agent runtime editor did not expose `llm_config.provider`, so additional DB connections could not be selected.

## Changes Implemented
- Updated `ui/src/components/RightPanel.tsx`:
  - Added `Saved LLM connections` selector.
  - Added `+ Add new connection` flow with provider key input.
  - Added provider key normalization (`lowercase`, spaces -> hyphen).
  - Added enabled toggle and generalized save/test actions for any provider key.
- Updated `ui/src/pages/AgentConfigPage.tsx`:
  - Added `Provider connection` selector bound to runtime profile `llm_config.provider`.
  - Added warning when selected provider has no saved connection record.
  - Refreshed page data to include connections and collections.
- Updated `backend/src/ghostdash_api/control_api.py`:
  - `/api/connections/test` now supports testing brand-new provider keys before save.
  - Returns HTTP 400 for provider config/value errors instead of generic 500.

## Runtime Verification Performed
- Rebuilt and restarted services:
  - `docker compose up -d --build control-api agent-ingress ui`
- Executed API verification script against live stack (`http://localhost/api`):
  - Saved second provider: `openai-staging` -> **200 OK**
  - Listed connections and confirmed provider presence -> **true**
  - Tested unknown provider without key -> **400** with expected detail:
    - `No API key configured for the selected provider connection`
  - Saved default agent runtime profile with `llm_config.provider = openai-staging` -> **200 OK**
  - Re-fetched agents and confirmed provider persisted -> `openai-staging`

## Acceptance Criteria
- [x] User can add an additional LLM connection from the UI panel.
- [x] Multiple connection records can exist and be listed.
- [x] Agent runtime profile can select and persist a non-default provider key.
- [x] Connection test endpoint handles unsaved providers gracefully (validation errors as 400, not 500).

## Human Test Checklist
1. Open `Connections` page -> `Manage providers`.
2. Click `New` and add provider key (example: `openai-prod`), label, API key, base URL.
3. Save and confirm it appears in saved list and in connections cards.
4. Open `Agent Configuration`.
5. Set `Provider connection` to the newly added provider and save.
6. Open `/chat`, use the edited agent, send a prompt, and confirm expected provider route behavior.

## Exact Verify Commands
```bash
cd /var/llamaindex/ghoststack-rag
docker compose up -d --build control-api agent-ingress ui
curl -sS http://localhost/api/connections | jq
curl -sS -X POST http://localhost/api/connections \
  -H 'content-type: application/json' \
  -d '{"provider":"openai-staging","label":"OpenAI Staging","base_url":"https://api.openai.com/v1","enabled":false}' | jq
curl -sS -X POST http://localhost/api/connections/test \
  -H 'content-type: application/json' \
  -d '{"provider":"temp-provider-check","label":"Temp Provider","api_mode":"responses","base_url":"https://api.openai.com/v1","prompt":"Reply ok"}' | jq
curl -sS http://localhost/api/agents | jq
```
