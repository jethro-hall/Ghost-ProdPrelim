# Ghost-ProdPrelim

Preliminary home for the GhostDash / Magic Mike production rebuild, specs, and the **ghoststack-rag** implementation used in the stack.

## Purpose

This repository is a single place for the production rebuild: planning docs, operator specs, and runnable code. The prelim `docs/` tree and `.cursor` rules are the design spine; the root application layout matches **ghoststack-rag** (stack, backend, UI).

## Critical rule

Do not make Magic Mike a document bot, finance bot, or generic RAG assistant.

Magic Mike is a Ride Electric consumer customer voice agent.

## First build phase (customer-facing)

```text
- production chat route correctness
- Magic Mike consumer_customer runtime isolation
- Odoo hard-disable for Magic Mike
- phone-call preview / open streaming UX
- final transcript auto-send
- ElevenLabs selected voice audio playback
- barge-in
- guardrail path before display and speech
```

Admin console work (for example HubTiger diagnostics) is Phase 2 unless needed to unblock Phase 1.

## What runs (ghoststack-rag)

- `caddy`: edge proxy for UI + API on port `80`
- `ui`: GhostDASH operator console (`Vite + React + TypeScript`)
- `control-api`: operator control plane (uploads, documents, vector stats, ingest, agents, HubTiger admin APIs where implemented)
- `agent-ingress`: `/agent/*` runtime boundary for chat and streaming
- `workflow-runtime`: LlamaIndex workflow for ingestion and query planning
- `postgres`: system of record
- `qdrant`: vector store

## Quick start (local)

1. Copy `.env.example` to `.env` and fill values; preserve any existing production `.env` when moving hosts.
2. Start the stack:

```bash
docker compose up -d --build
```

3. UI: `http://localhost/`
4. Control API docs: `http://localhost/api/docs`
5. Agent ingress: `http://localhost/agent/docs`
6. Health: `http://localhost/health`

## API surface (high level)

- `GET/POST` `/api/connections`, `/api/runtime/defaults`, `/api/agents`, `/api/upload`, `/api/sync`, `/api/documents`, `/api/vector-stats`, `/api/tasks/{task_id}`
- `POST` `/agent/chat`, `/agent/chat/stream`
- Boundaries: `/api/*` operator; `/agent/*` runtime

## Start here (docs)

Planning and index:

- `docs/INDEX.md` (if present in this tree)
- `docs/CODE_REVIEW_PLAN.md` / `docs/PHASE_1_BUILD_BRIEF.md` (prelim specs, where present)

Repository architecture and artifacts:

- `docs/ARCHITECTURE.md`, `docs/GHOSTDASH_UI_ARCHITECTURE.md`, `docs/HANDOFF.md`
- `artefacts/` (runbooks, phase evidence, screenshots as committed)

## Ingestion and query (summary)

- Workflow: parse and structure, retrieval artifacts, embed, index; lanes: local / cloud (LlamaParse) per policy
- `docs/STRUCTURE_AWARE_CHUNKING_ARTIFACT.md` and related milestone docs for details
