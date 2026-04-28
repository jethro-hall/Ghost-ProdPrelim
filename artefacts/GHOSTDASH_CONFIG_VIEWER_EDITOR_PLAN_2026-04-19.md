# GhostDASH Config Viewer + Editor Plan (2026-04-19)

## Objective

Make key runtime behavior configurable and visible inside GhostDASH so operators can search, inspect, and safely edit JSON-backed settings without code edits.

## Why this is needed

- Hardcoded guardrail behavior does not scale for production operations.
- Operators need immediate visibility into live policy state.
- Prompt/format/report/doc-finalize rules should be adjustable per runtime profile.

## Scope

### 1) Config Registry (backend)

Add a canonical config registry model:

- `config_key` (unique)
- `config_namespace` (e.g., `guardrails`, `docx`, `reporting`, `security`)
- `value_json` (JSONB)
- `schema_json` (JSON Schema)
- `is_sensitive` (bool)
- `version` (integer)
- `updated_by`, `updated_at`

### 2) Safe API contract

New control API endpoints:

- `GET /api/config?namespace=<...>&q=<...>`
- `GET /api/config/{key}`
- `PATCH /api/config/{key}`
- `POST /api/config/validate`
- `GET /api/config/history/{key}`

Safety:

- JSON schema validation before write
- optimistic locking by `version`
- audit trail for every change
- deny editing protected keys without admin role

### 3) GhostDASH UI page

Add `Settings / Config Explorer` page:

- search by key/namespace/content
- JSON viewer with syntax highlighting
- inline schema and validation errors
- diff preview before save
- rollback action using version history

### 4) Runtime-profile integration

For agent runtime guardrails, show editable JSON blocks in:

- `board_document_format_contract`
- `financial_report_format_contract`
- `docx_finalize_required_sections`
- questionnaire contracts

### 5) Governance

- Every config write produces an audit record with before/after JSON.
- Include `approval_token` flow when profile policy mode is `admin_approval_required`.

## Acceptance Criteria

1. Operators can search and view config keys in-app.
2. JSON edits are schema-validated and versioned.
3. Sensitive keys are protected by role checks.
4. Every change is auditable and reversible.
5. Runtime guardrail/reporting/docx contracts can be edited without code deploy.

## Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-caddy-1
```

```bash
cd /var/llamaindex/ghoststack-rag/backend
pytest -q tests/test_runtime_profiles.py tests/test_control_api_runtime_profiles.py
```

```bash
cd /var/llamaindex/ghoststack-rag/ui
npm run lint && npm run build -- --outDir dist-verify-config-explorer
```
