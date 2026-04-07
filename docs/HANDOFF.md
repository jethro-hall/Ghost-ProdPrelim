# Handoff Status

Last updated: 2026-04-06

## Current live stack

- Repo root: `/var/llamaindex/ghoststack-rag`
- Public HTTPS URL: `https://ghoststack.rideai.com.au`
- Public health URL: `https://ghoststack.rideai.com.au/health`
- Control API docs: `https://ghoststack.rideai.com.au/api/docs`
- Agent ingress docs: `https://ghoststack.rideai.com.au/agent/docs`

Running containers at handoff:

- `ghoststack-rag-caddy-1`
- `ghoststack-rag-ui-1`
- `ghoststack-rag-control-api-1`
- `ghoststack-rag-agent-ingress-1`
- `ghoststack-rag-workflow-runtime-1`
- `ghoststack-rag-postgres-1`
- `ghoststack-rag-qdrant-1`

## Completed so far

- The repo is cut over to a LlamaIndex-native workflow shape with:
  - `control-api` for `/api/*`
  - `agent-ingress` for `/agent/*`
  - `workflow-runtime` for ingestion and query planning
  - `postgres` as the system of record
  - `qdrant` for retrieval artifacts
- `llama-stack` is no longer in the primary runtime path.
- Caddy now routes:
  - `/api/*` → `control-api:8000`
  - `/agent/*` → `agent-ingress:8001`
  - `/` → `ui:4173`
- Runtime defaults are persisted in the backend through `/api/runtime/defaults`.
- The UI now:
  - keeps operator state on `/api/*`
  - sends GhostChat traffic to `/agent/*`
  - shows workbook sheet/table/row counts in the dashboard
  - shows query mode in GhostChat
- XLSX ingestion is now table-first and hybrid:
  - workbook structure is stored in Postgres
  - row and sheet summaries are created as retrieval artifacts
  - exact structured lookups work without reparsing the file
- Structured JSON observability remains in place across all three backend services.
- Alembic scaffolding is present under `backend/alembic/` for the Postgres-backed schema.

## End-to-end verification

Verified against the live HTTPS stack:

- `docker compose config`: passed
- backend compile: passed
- UI lint/build in container: passed
- `GET /api/capabilities`: passed
- `GET /api/runtime/defaults`: passed
- `GET /api/docs`: passed
- `POST /api/upload`: passed
- `POST /api/sync`: passed
- `GET /api/tasks/{id}`: passed
- `GET /api/documents?corpus=<xlsx-corpus>`: passed
- `POST /agent/chat`: passed
- `POST /agent/chat/stream`: passed

Live XLSX smoke result:

- uploaded `ghostdash-agent.xlsx`
- full sync completed successfully
- `/api/documents` returned:
  - `requested_lane: local`
  - `actual_parse_lane: local_xlsx`
  - `parse_status: completed`
  - `index_status: completed`
  - `workbook_sheet_count: 1`
  - `workbook_table_count: 1`
  - `workbook_row_count: 2`
  - artifact summaries for `sheet_summary` and `row_summary`
- exact query smoke:
  - `What is amount for RideAI?`
  - returned `Amount is 1250` with sheet/table/row provenance
- blended query smoke:
  - `Summarize the spreadsheet.`
  - returned a grounded summary with citations

## Important repo notes

- Structured workbook data now belongs in the app database (`postgres`), not in `Llama Stack` internal state.
- `LLAMA_CLOUD_API_KEY` is still not configured in the live environment, so cloud parse enrichment remains blocked.
- The legacy `main.py` and `worker.py` entrypoints now delegate to the new service modules for compatibility.

## Operational follow-up

1. Set `LLAMA_CLOUD_API_KEY` in the live `.env` to activate cloud parse enrichment.
2. Add a real Alembic revision history now that the baseline Postgres schema is stable.
3. Expand structured lookup beyond the current heuristic router if you need richer filter expressions or multi-table joins.

## Exact verify commands

Repo state:

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
```

Container state:

```bash
cd /var/llamaindex/ghoststack-rag
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

Compose validation:

```bash
cd /var/llamaindex/ghoststack-rag
docker compose config
```

Backend compile:

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 -m compileall backend/src
```

UI validation:

```bash
cd /var/llamaindex/ghoststack-rag
docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"
```

Capabilities and defaults:

```bash
python3.12 - <<'PY'
import urllib.request
base = "https://ghoststack.rideai.com.au"
print(urllib.request.urlopen(base + "/api/capabilities", timeout=120).read().decode())
print(urllib.request.urlopen(base + "/api/runtime/defaults", timeout=120).read().decode())
PY
```

XLSX ingest and agent smoke:

```bash
cd /var/llamaindex/ghoststack-rag
docker exec ghoststack-rag-control-api-1 python -c "from openpyxl import Workbook; wb=Workbook(); ws=wb.active; ws.title='Orders'; ws.append(['customer','amount','status']); ws.append(['RideAI',1250,'paid']); ws.append(['GhostStack',980,'pending']); wb.save('/tmp/ghostdash-agent.xlsx')" \
  && docker cp ghoststack-rag-control-api-1:/tmp/ghostdash-agent.xlsx /tmp/ghostdash-agent.xlsx

export CORPUS="xlsx-native-$(date +%s)"
curl -sS -X POST "https://ghoststack.rideai.com.au/api/upload" \
  -F "corpus=${CORPUS}" \
  -F "policy_lane=local" \
  -F "file=@/tmp/ghostdash-agent.xlsx;type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

python3.12 - <<'PY'
import json, os, time, urllib.request
base = "https://ghoststack.rideai.com.au"
corpus = os.environ["CORPUS"]
req = urllib.request.Request(base + "/api/sync", data=json.dumps({"corpus": corpus}).encode(), method="POST")
req.add_header("Content-Type", "application/json")
task = json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
for _ in range(60):
    time.sleep(2)
    state = json.loads(urllib.request.urlopen(base + "/api/tasks/" + task["id"], timeout=120).read().decode())
    if state["status"] in {"completed", "failed"}:
        break
print("TASK", json.dumps(state))
print("DOCS", urllib.request.urlopen(base + "/api/documents?corpus=" + corpus, timeout=120).read().decode())
for prompt in ["What is amount for RideAI?", "Summarize the spreadsheet."]:
    req = urllib.request.Request(
        base + "/agent/chat",
        data=json.dumps({"message": prompt, "corpora": [corpus], "top_k": 6, "api_mode": "responses"}).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    print("CHAT", prompt, urllib.request.urlopen(req, timeout=120).read().decode())
PY
```
