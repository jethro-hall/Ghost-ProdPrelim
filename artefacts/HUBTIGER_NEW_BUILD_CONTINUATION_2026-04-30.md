# Hubtiger New Build Continuation

Date: 2026-04-30
Owner: GhostDASH build stream
Status: Executed (build + automated verification complete, human QA pending)

## Requirement

Continue the new Hubtiger build using the new tree path and standardized service split, then verify it end-to-end from operator and customer-facing behavior.

## Minimal Evidence Baseline (Captured)

1. Working tree is dirty and already contains Hubtiger build work (`services/hubtiger-mcp`, `backend/src/ghostdash_api/hubtiger_mcp.py`, tests, docs, scripts).
2. Running stack includes:
   - `ghoststack-rag-hubtiger-proxy-1`
   - `ghoststack-rag-hubtiger-mcp-1`
   - `ghoststack-rag-control-api-1`
   - `ghoststack-rag-agent-ingress-1`
   - `ghoststack-rag-caddy-1`
3. Requested legacy container names (`ghost-edge-gateway`, `ghost-control-plane`) are not present in this stack, so diagnostics must target the canonical compose service names above.

## Repo-Real New Tree Path (Source Of Truth)

- MCP service code: `services/hubtiger-mcp/`
- Proxy service code: `scripts/hubtiger/hubtiger-proxy/`
- Python adapter + routing: `backend/src/ghostdash_api/hubtiger_mcp.py`
- Voice/tool ingress route: `backend/src/integrations/elevenlabs_hubtiger/router.py`
- Compose wiring: `docker-compose.yml`
- Operator docs: `docs/HUBTIGER_OPERATOR_PLAYBOOK.md`, `docs/HUBTIGER_TOOL_ARCHITECTURE.md`
- Build artefacts: `artefacts/`

## Diagnose Before Prescribe

### Root cause

Hubtiger behavior drifted previously because operation names, MCP mappings, and runtime write capability were not fully aligned across prompt, control-api adapter, and MCP service.

### Correct layer

- Operation normalization and tool safety: `control-api` boundary (`backend/src/ghostdash_api/hubtiger_mcp.py`)
- Deterministic method/path execution: `hubtiger-mcp` service (`services/hubtiger-mcp/index.js`)
- External API specifics: `hubtiger-proxy` service (`scripts/hubtiger/hubtiger-proxy`)
- Runtime wiring and service ownership: `docker-compose.yml`

### Existing components to reuse

- Existing Hubtiger MCP + proxy services in compose
- Existing ElevenLabs Hubtiger tool endpoint under `/api/elevenlabs/hubtiger/tool`
- Existing backend tests for adapter/ingress behavior

### Proposed change (continuation)

Finalize the standardized build by treating `services/hubtiger-mcp/` as canonical MCP runtime, keep proxy in `scripts/hubtiger/hubtiger-proxy/`, and complete verification for read-mode truthfulness plus write-path readiness gates.

### Why this is not a one-off patch

This keeps one deterministic path (`control-api` -> `hubtiger-mcp` -> `hubtiger-proxy`) and removes fallback ambiguity, so future Hubtiger features extend one architecture instead of parallel routes.

### Token/resource impact

- Lower LLM token usage from deterministic operation routing and payload shaping.
- Reduced support/debug overhead by failing blocked/unavailable paths explicitly.

### Cleanup required

- Remove obsolete Hubtiger naming/docs/scripts once parity is confirmed.
- Keep only canonical tool names and mappings in prompt/admin surfaces.

### Tests/proof required

- Backend tests for mapping, policy blocking, and ingress behavior.
- MCP service tests for execute/test routing.
- Compose config validation.
- Human QA through live operator flow.

## Execution Plan (Continue Now)

### Phase 1: Lock Canonical Build Surface

1. Confirm compose points MCP build to `./services/hubtiger-mcp`.
2. Confirm `control-api` depends on healthy `hubtiger-mcp`.
3. Confirm only one Hubtiger MCP runtime service is active.

### Phase 2: Build + Restart Affected Services

Use:

```bash
docker compose up -d --build hubtiger-proxy hubtiger-mcp control-api agent-ingress
```

Then verify service health (through compose network because these ports are not host-published):

```bash
docker compose ps
docker compose exec -T control-api python -c "import urllib.request;print(urllib.request.urlopen('http://hubtiger-mcp:8096/health').read().decode())"
docker compose exec -T control-api python -c "import urllib.request;print(urllib.request.urlopen('http://hubtiger-proxy:8095/health').read().decode())"
```

### Phase 3: Deterministic Behavior Verification

1. Confirm status surface and binding names:

```bash
curl -sS http://localhost/api/hubtiger/status
```

2. Confirm read/write policy behavior:

```bash
curl -sS -X POST http://localhost/api/hubtiger/test -H "Content-Type: application/json" -d '{"operation":"booking_create","store":"southport","payload":{}}'
```

3. Confirm unsupported MCP test operation fails explicitly (no fallback to job search):

```bash
docker compose exec -T control-api python -c "import json,urllib.request,urllib.error;req=urllib.request.Request('http://hubtiger-mcp:8096/test',data=json.dumps({'operation':'unsupported_operation','store':'southport','payload':{}}).encode(),headers={'Content-Type':'application/json'},method='POST'); \
try: print(urllib.request.urlopen(req).read().decode()); \
except urllib.error.HTTPError as e: print(e.read().decode())"
```

### Phase 4: Automated Test Proof

Backend:

```bash
docker run --rm -e PYTHONPATH=/app/src -v "/var/llamaindex/ghoststack-rag/backend:/app" ghoststack-rag-control-api \
  python -m pytest \
  tests/test_hubtiger_mcp_adapter.py \
  tests/test_elevenlabs_hubtiger_ingress.py \
  tests/test_hubtiger_elevenlabs_tool.py
```

Node MCP:

```bash
docker run --rm -v "/var/llamaindex/ghoststack-rag/services/hubtiger-mcp:/src:ro" node:20-alpine sh -lc \
  "cp -r /src /tmp/app && cd /tmp/app && npm install >/tmp/npm-install.log 2>&1 && node --test index.test.js"
```

Compose:

```bash
docker compose config
```

### Phase 5: Human QA (Required)

Operator flow must be tested from a human perspective:

1. Open GhostDASH Agent Config and verify only canonical Hubtiger bindings are shown.
2. Run one `lookup_job` scenario (valid identifier).
3. Run one `booking_availability` scenario (store + date).
4. Run one blocked write scenario and verify customer-safe next-step wording.
5. Confirm no internal traces/errors leak in user-visible responses.

## Acceptance Criteria

1. Hubtiger new tree path is canonical in compose and runtime (`services/hubtiger-mcp`).
2. MCP/proxy/control-api health checks pass.
3. Unsupported operations fail explicitly (no deceptive fallback).
4. Read-only mode blocks writes deterministically.
5. Backend and MCP automated tests pass.
6. Human QA flow passes with customer-safe output.

## Execution Results (2026-04-30)

### Build and restart

- `docker compose up -d --build hubtiger-proxy hubtiger-mcp control-api agent-ingress` completed successfully.
- `hubtiger-mcp`, `workflow-runtime`, `control-api`, and `agent-ingress` were recreated and returned to healthy/started states.

### Deterministic behavior checks

- `GET /api/hubtiger/status` returned healthy status and canonical five bindings.
- `POST /api/hubtiger/test` with `booking_create` returned deterministic read-only block.
- `POST /api/hubtiger/test` with `job_lookup` returned successful matches.
- MCP direct `/test` with unsupported operation returned `unsupported_hubtiger_test_operation`.

### Automated tests

- Backend test run: `17 passed, 1 warning`
  - `tests/test_hubtiger_mcp_adapter.py`
  - `tests/test_elevenlabs_hubtiger_ingress.py`
  - `tests/test_hubtiger_elevenlabs_tool.py`
- Node MCP test run: `3 passed`
  - `services/hubtiger-mcp/index.test.js`
- Compose validation: `docker compose config` succeeded.

## Ready Testing Pack (Copy/Paste)

### A) Quick smoke (2-3 minutes)

```bash
docker compose ps
curl -sS http://localhost/api/hubtiger/status
curl -sS -X POST http://localhost/api/hubtiger/test -H "Content-Type: application/json" -d '{"operation":"booking_create","store":"southport","payload":{}}'
curl -sS -X POST http://localhost/api/hubtiger/test -H "Content-Type: application/json" -d '{"operation":"job_lookup","store":"southport","payload":{"phone":"0435185134"}}'
```

Pass when:

- status shows `health: healthy`
- `booking_create` returns `blocked: true` in `read_only` mode
- `job_lookup` returns `success: true`

### B) Deep automated verification (8-15 minutes)

```bash
docker compose config
docker run --rm -e PYTHONPATH=/app/src -v "/var/llamaindex/ghoststack-rag/backend:/app" ghoststack-rag-control-api python -m pytest tests/test_hubtiger_mcp_adapter.py tests/test_elevenlabs_hubtiger_ingress.py tests/test_hubtiger_elevenlabs_tool.py
docker run --rm -v "/var/llamaindex/ghoststack-rag/services/hubtiger-mcp:/src:ro" node:20-alpine sh -lc "cp -r /src /tmp/app && cd /tmp/app && npm install >/tmp/npm-install.log 2>&1 && node --test index.test.js"
```

Pass when:

- pytest ends with all selected tests passed
- Node MCP test ends with `pass 3 fail 0`
- compose config exits successfully

### C) Fail-closed MCP routing check

```bash
docker compose exec -T control-api python -c "import json,urllib.request,urllib.error;req=urllib.request.Request('http://hubtiger-mcp:8096/test',data=json.dumps({'operation':'unsupported_operation','store':'southport','payload':{}}).encode(),headers={'Content-Type':'application/json'},method='POST'); \
try: print(urllib.request.urlopen(req).read().decode()); \
except urllib.error.HTTPError as e: print(e.read().decode())"
```

Pass when:

- response contains `unsupported_hubtiger_test_operation`
- no fallback behavior to unrelated search operation appears

### D) Human QA run-sheet (operator perspective)

1. Open GhostDASH and go to Agent Config.
2. Confirm only canonical Hubtiger bindings are visible.
3. Run `lookup_job` with a valid phone and confirm concise, usable result.
4. Run `booking_availability` with store/date and confirm actionable options.
5. Run blocked write (`booking_create`) and confirm safe next-step wording.
6. Confirm customer-visible responses do not expose traces/internal diagnostics.

Pass when:

- operator can complete each flow without confusion
- blocked paths are honest and actionable
- no internal implementation details leak into customer text

### E) One-line rerun bundle

```bash
docker compose ps && curl -sS http://localhost/api/hubtiger/status && docker run --rm -e PYTHONPATH=/app/src -v "/var/llamaindex/ghoststack-rag/backend:/app" ghoststack-rag-control-api python -m pytest tests/test_hubtiger_mcp_adapter.py tests/test_elevenlabs_hubtiger_ingress.py tests/test_hubtiger_elevenlabs_tool.py && docker run --rm -v "/var/llamaindex/ghoststack-rag/services/hubtiger-mcp:/src:ro" node:20-alpine sh -lc "cp -r /src /tmp/app && cd /tmp/app && npm install >/tmp/npm-install.log 2>&1 && node --test index.test.js"
```

## Exact Verify Commands

```bash
docker compose config
docker compose ps
docker compose exec -T control-api python -c "import urllib.request;print(urllib.request.urlopen('http://hubtiger-mcp:8096/health').read().decode())"
docker compose exec -T control-api python -c "import urllib.request;print(urllib.request.urlopen('http://hubtiger-proxy:8095/health').read().decode())"
curl -sS http://localhost/api/hubtiger/status
docker run --rm -e PYTHONPATH=/app/src -v "/var/llamaindex/ghoststack-rag/backend:/app" ghoststack-rag-control-api python -m pytest tests/test_hubtiger_mcp_adapter.py tests/test_elevenlabs_hubtiger_ingress.py tests/test_hubtiger_elevenlabs_tool.py
docker run --rm -v "/var/llamaindex/ghoststack-rag/services/hubtiger-mcp:/src:ro" node:20-alpine sh -lc "cp -r /src /tmp/app && cd /tmp/app && npm install >/tmp/npm-install.log 2>&1 && node --test index.test.js"
```

## Risks / Open Items

1. Live write success remains dependent on runtime env (`HUBTIGER_TOOL_ACCESS`, portal mode, partner/account credentials).
2. Upstream Hubtiger portal endpoints can still return external dependency failures that are not local build defects.
3. Existing dirty tree includes unrelated changes; commit scoping must be controlled to avoid accidental bundling.
4. `docker compose config` prints fully resolved environment values; do not share raw output externally. Keep logs/artefacts redacted for secrets.

## Continuation Decision

Phase 2 through Phase 4 are completed. Next is Phase 5 human QA (operator UX pass in browser) and then optional write-path enablement test under explicit read_write runtime settings.

## Phase 2 Started: Bi-Directional Cache Options

Implemented in `services/hubtiger-mcp/index.js` with test coverage in `services/hubtiger-mcp/index.test.js`.

### What changed

1. Added cache profile support:
   - `HUBTIGER_MCP_CACHE_PROFILE=conservative|performance`
2. Added cache direction support:
   - `HUBTIGER_MCP_CACHE_DIRECTION=request_only|bi_directional`
3. Added per-operation TTL controls:
   - `HUBTIGER_MCP_CACHE_TTL_JOB_LOOKUP`
   - `HUBTIGER_MCP_CACHE_TTL_AVAILABILITY`
   - `HUBTIGER_MCP_CACHE_TTL_QUOTE_PREVIEW`
4. Added short negative-cache support for transient read failures:
   - `HUBTIGER_MCP_NEGATIVE_CACHE_TTL_SECONDS` (default `3`)
5. Added health visibility:
   - `/health` now reports `cache_profile`, `cache_direction`, and default TTL.

### Bi-directional behavior

When `HUBTIGER_MCP_CACHE_DIRECTION=bi_directional` and `job_lookup` succeeds, MCP now writes alias cache keys for:

- `GET /jobs/{id}`
- `POST /jobs/search` by `id`
- `POST /jobs/search` by `jobCardNo`

This allows repeated lookups via different identifiers to reuse the same cached payload and reduce upstream chatter.

### Recommended option sets

#### Option A: Conservative (freshness-first)

```env
HUBTIGER_MCP_CACHE_PROFILE=conservative
HUBTIGER_MCP_CACHE_DIRECTION=request_only
HUBTIGER_MCP_NEGATIVE_CACHE_TTL_SECONDS=3
HUBTIGER_MCP_CACHE_TTL_JOB_LOOKUP=20
HUBTIGER_MCP_CACHE_TTL_AVAILABILITY=60
HUBTIGER_MCP_CACHE_TTL_QUOTE_PREVIEW=10
```

#### Option B: Bi-directional performance (speed-first)

```env
HUBTIGER_MCP_CACHE_PROFILE=performance
HUBTIGER_MCP_CACHE_DIRECTION=bi_directional
HUBTIGER_MCP_NEGATIVE_CACHE_TTL_SECONDS=5
HUBTIGER_MCP_CACHE_TTL_JOB_LOOKUP=60
HUBTIGER_MCP_CACHE_TTL_AVAILABILITY=120
HUBTIGER_MCP_CACHE_TTL_QUOTE_PREVIEW=30
```

### Verify commands (Phase 2 cache)

```bash
docker run --rm -v "/var/llamaindex/ghoststack-rag/services/hubtiger-mcp:/src:ro" node:20-alpine sh -lc "cp -r /src /tmp/app && cd /tmp/app && npm install >/tmp/npm-install.log 2>&1 && node --test index.test.js"
curl -sS http://localhost/api/hubtiger/status
docker compose exec -T control-api python -c "import urllib.request;print(urllib.request.urlopen('http://hubtiger-mcp:8096/health').read().decode())"
```

## Phase 2.1: Lookup -> Jobcard Follow-up Alignment

### Requirement

After `lookup_job`, the follow-up request for a selected case must stay on a deterministic route that does not hit the known `/jobs/{id}` 404 path in this runtime.

### Root cause

`job_lookup` used mixed routes:

- phone/name -> `POST /jobs/search`
- `job_id` -> `GET /jobs/{id}`

In the current runtime, `GET /jobs/{id}` returned unavailable/404 while `/jobs/search` remained healthy.

### Change implemented

Aligned `job_lookup` with `job_id` to use deterministic search routing:

- `POST /jobs/search` with `q=job_id` and `allStores=true`

Updated in:

- `backend/src/ghostdash_api/hubtiger_mcp.py`
- `services/hubtiger-mcp/index.js`
- `backend/tests/test_hubtiger_mcp_adapter.py`
- `services/hubtiger-mcp/index.test.js`
- `docs/HUBTIGER_OPERATOR_PLAYBOOK.md`
- `docs/HUBTIGER_TOOL_ARCHITECTURE.md`

### Verification (executed)

Automated:

- `pytest tests/test_hubtiger_mcp_adapter.py` -> `8 passed`
- `node --test index.test.js` -> `6 passed`

Runtime:

- `job_lookup` by phone returns expected matches and case options.
- `job_lookup` follow-up by `job_id` no longer fails with 404; now returns deterministic search response.

### Current functional note

For reliable single-case follow-up in this runtime, use `job_card_no` from `case_select.options` (for example `#35872`) in the second step.

## Phase 2.2: Explicit Search -> Retrieve Workflow

### Requirement

Support an explicit two-step workflow:

1. Search for jobs.
2. Retrieve a selected job.

### Root cause

A single mixed `job_lookup` operation forced both "find cases" and "open selected case" through one semantic surface, which made operator intent less explicit.

### Correct layer

- Operation contract and validation: `backend/src/ghostdash_api/hubtiger_mcp.py`, `backend/src/ghostdash_api/schemas.py`
- MCP route mapping: `services/hubtiger-mcp/index.js`
- Tool surface and guidance: `backend/src/ghostdash_api/control_api.py`, `backend/src/ghostdash_api/magic_mike.py`, docs

### Changes implemented

Added explicit read operations:

- `job_search` (customer/job search list)
- `job_retrieve` (selected case retrieval by `job_card_no` or `job_id`)

Kept `job_lookup` for backward compatibility.

Updated files:

- `backend/src/ghostdash_api/hubtiger_mcp.py`
- `backend/src/ghostdash_api/schemas.py`
- `services/hubtiger-mcp/index.js`
- `backend/tests/test_hubtiger_mcp_adapter.py`
- `services/hubtiger-mcp/index.test.js`
- `backend/src/ghostdash_api/control_api.py`
- `backend/src/ghostdash_api/magic_mike.py`
- `docs/HUBTIGER_OPERATOR_PLAYBOOK.md`
- `docs/HUBTIGER_TOOL_ARCHITECTURE.md`

### Automated tests run

- `pytest tests/test_hubtiger_mcp_adapter.py` -> `10 passed`
- `node --test index.test.js` -> `8 passed`

### Runtime verification

`job_search` live call:

- `POST /api/hubtiger/test` with phone `0435185134`
- returned multi-case list (`count: 3`) with `case_select.options`

`job_retrieve` live call:

- `POST /api/hubtiger/test` with `job_card_no: #35872`
- returned selected case (`count: 1`) successfully

### Acceptance Criteria

1. Explicit job search operation exists and is callable (`job_search`): ✅
2. Explicit selected-case retrieval operation exists and is callable (`job_retrieve`): ✅
3. Legacy `job_lookup` remains available for compatibility: ✅
4. Backend and MCP tests pass with new operation coverage: ✅
5. Live API verifies search and retrieve steps end-to-end: ✅

### Exact verify commands

```bash
docker run --rm -e PYTHONPATH=/app/src -v "/var/llamaindex/ghoststack-rag/backend:/app" ghoststack-rag-control-api python -m pytest tests/test_hubtiger_mcp_adapter.py
docker run --rm -v "/var/llamaindex/ghoststack-rag/services/hubtiger-mcp:/src:ro" node:20-alpine sh -lc "cp -r /src /tmp/app && cd /tmp/app && npm install >/tmp/npm-install.log 2>&1 && node --test index.test.js"
docker compose up -d --build hubtiger-mcp control-api
curl -i -X POST http://localhost/api/hubtiger/test -H "Content-Type: application/json" -d '{"operation":"job_search","store":"southport","payload":{"phone":"0435185134"}}'
curl -i -X POST http://localhost/api/hubtiger/test -H "Content-Type: application/json" -d '{"operation":"job_retrieve","store":"southport","payload":{"job_card_no":"#35872"}}'
```

## Phase 2.3: Deployment parity release checks

Before live verification, confirm running containers use the updated control-api and hubtiger-mcp build:

```bash
docker compose up -d --build control-api hubtiger-mcp
docker compose ps
docker compose images control-api hubtiger-mcp
docker inspect ghoststack-rag-control-api-1 --format '{{.Image}}'
docker inspect ghoststack-rag-hubtiger-mcp-1 --format '{{.Image}}'
```

If production still returns `Lookup-only mode supports \`lookup_job\`.`, deployment is stale; rebuild and restart `control-api` first, then re-run endpoint verification.
