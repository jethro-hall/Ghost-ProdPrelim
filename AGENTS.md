# GhostDASH — Agent Operating Rules (Repo-First, Drift-Intolerant)

## Project context

GhostDASH is the operator console and control plane for a LlamaIndex-native workflows + provider-backed RAG platform.

- Frontend: Vite + React + TypeScript + Tailwind + Motion-style interactions
- Backend: Python control API and ingestion worker under `backend/src/ghostdash_api/`
- Runtime services: `caddy`, `ui`, `control-api`, `agent-ingress`, `workflow-runtime`, `postgres`, `qdrant`
- Deployment: one canonical `docker-compose.yml` and one canonical `Caddyfile`

## Non-negotiables

1. SPA only
- No full-page reloads for internal navigation.

2. Clean boundaries
- Browser control traffic goes through `/api/*`.
- Browser chat traffic goes through `/agent/*`.
- The browser never talks to OpenAI, Qdrant, or other privileged services directly.

3. Current storage reality
- App state is Postgres in the current compose.
- Qdrant is the vector store.
- Do not write guidance that assumes a graph database is already present unless you are explicitly planning a migration.

4. HTTPS at the edge
- Caddy is the edge gateway.
- Keep Caddy routes aligned with the services and ports in `docker-compose.yml`.

5. Observability first
- Every inbound request and every outbound service/tool call must emit structured JSON logs with:
  `trace_id`, `span_id`, `service`, `route`, `start_ts`, `end_ts`, `latency_ms`, `status`, `error`
- Async work kicked off by an API request must preserve the originating `trace_id` into worker execution and downstream calls.

## Repo-first / no invented names

Before changing infra or app wiring, read:

- `docs/ARCHITECTURE.md`
- `docs/GHOSTDASH_UI_ARCHITECTURE.md`
- `docs/OPERATIONS.md`
- `docker-compose.yml`
- `Caddyfile`
- `backend/src/ghostdash_api/main.py`
- `backend/src/ghostdash_api/worker.py`
- `ui/src/components/AppLayout.tsx`
- `ui/src/index.css`

Do not invent service names, ports, env vars, mounts, or routes.

## Canonical config files

- `docker-compose.yml` is the only compose file.
- `Caddyfile` is the only edge config.

For config files such as `docker-compose.yml` and `Caddyfile`, perform full-file rewrites when editing them.

## Llama-oriented plans (LlamaIndex templates)

GhostDASH runs on **LlamaIndex workflows plus provider APIs**, and the **LlamaIndex `llamactl` templates** in the workspace are the canonical reference for how to shape RAG, parsing, extraction, workflow UIs, and agent patterns.

- Templates live at **`llama-agent-templates/`** (same parent as this repo when the workspace is `/var/llamaindex`).
- For any plan touching retrieval, ingest, parse lanes, chat-over-docs, or extraction: read the closest template’s **`AGENTS.md`** first, then align implementation with **`llama-stack`**, **`stack/config.yaml`**, and this repo’s API/worker—**never** expose Stack or vector APIs to the browser.
- Use the Cursor subagent **`llama-agent-templates`** (`.cursor/agents/llama-agent-templates.md`) when you need cross-template guidance or a clear **LlamaIndex → Llama Stack** mapping.

## RAG architect guidance

For ingestion, metadata schema, chunking, embeddings, vector design, or GraphRAG work in this repo:

- Auto guidance lives in `.cursor/rules/50-rag-data-architect.mdc`.
- Explicit invocation lives in `.cursor/agents/rag-data-architect.md`.
- The repeatable planning workflow lives in `.cursor/skills/rag-ingestion-planner/SKILL.md`.
- Default repo posture remains `postgres` + `qdrant`; treat alternate vector or graph stores as migrations that must be justified against current repo reality.

## Definition of done

- `python3.12 -m compileall backend/src`
- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
- `docker compose config`
