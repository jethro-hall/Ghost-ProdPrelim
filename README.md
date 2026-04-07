# ghoststack-rag

A `GhostDASH` RAG platform rebuilt around a LlamaIndex-native workflow runtime, a thin control API, a dedicated agent ingress boundary, `Postgres` for structured state, and `Qdrant` for retrieval.

## What Runs

- `caddy`: simple edge proxy for UI + API on port `80`
- `ui`: GhostDASH operator console (`Vite + React + TypeScript`)
- `control-api`: operator-facing control plane for uploads, connections, runtime-profile compatibility views, documents, vector stats, and ingest runs
- `agent-ingress`: `/agent/*` runtime boundary for chat and streaming answers
- `workflow-runtime`: LlamaIndex workflow service for ingestion and query planning
- `postgres`: system of record for documents, workbook structure, ingestion runs, runtime profiles, provider connections, conversations, and cache state
- `qdrant`: vector database for chunk retrieval

## Design Goals

- LlamaIndex-native workflow orchestration for ingestion and query planning
- Mixed-policy ingestion lanes:
  - local/private parsing for restricted corpora
  - `LlamaParse` for allowed rich documents
- Table-first XLSX ingestion with relational persistence plus retrieval artifacts
- Durable vector retrieval with `Qdrant`
- Operator-grade admin UX with GhostDASH

## Quick Start

1. Preserve your existing `.env` and update values as needed.
2. Start the stack:

```bash
docker compose up -d --build
```

3. Open the UI at `http://localhost/`
4. Open the control API docs at `http://localhost/api/docs`
5. Open the agent ingress docs at `http://localhost/agent/docs`
6. Check the API health endpoint at `http://localhost/health`

## Core API Surface

- `GET /api/connections`
- `POST /api/connections`
- `GET /api/runtime/defaults` (compatibility view over the default runtime profile)
- `POST /api/runtime/defaults` (updates the default runtime profile through the compatibility contract)
- `GET /api/agents`
- `POST /api/agents`
- `POST /api/upload`
- `POST /api/sync`
- `GET /api/tasks/{task_id}`
- `GET /api/documents`
- `GET /api/vector-stats`
- `POST /agent/chat`
- `POST /agent/chat/stream`

## Ingestion Model

The workflow runtime processes uploaded files in ordered steps:
- parse and structure
- generate retrieval artifacts
- embed
- index

Files can be routed to either:
- `local` lane for on-box parsing only
- `cloud` lane for `LlamaParse` when policy allows it

## Query Boundaries

- `/api/*` is for operator/control-plane actions only
- `/agent/*` is for runtime chat and agent requests only

## Docs

- `docs/ARCHITECTURE.md`
- `docs/ARCHITECTURE_V2.md`
- `docs/GHOSTDASH_UI_ARCHITECTURE.md`
- `docs/HANDOFF.md`
- `docs/MILESTONE1_RUNTIME_PROFILE_ARTIFACT.md`
- `docs/STRUCTURE_AWARE_CHUNKING_ARTIFACT.md`
- `docs/VECTORS_PAGE_STATS_FIX_ARTIFACT.md`
- `docs/APPROVED_WEB_DECISION_ARTIFACT.md`
- `docs/PHASE2_DOCS_REALIGNMENT_ARTIFACT.md`
- `docs/PHASE2_VERIFY_CLEAN_RELEASE_ARTIFACT.md`
