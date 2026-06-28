# Agent Runtime — Service Contract

## What this service is

`agent-runtime` is the forensic data analysis sandbox in the GhostDASH stack. It is **not** a second chat or voice ingress — it is a purpose-built ReAct runtime for long-horizon, multi-step data analysis against Odoo accounting data and the GPU-accelerated rapids-analytics mirror.

## URL

`https://ghoststack.rideai.com.au/agent-runtime/`

Caddy routes `handle_path /agent-runtime/*` → `agent-runtime:8200`.

## Source location

`services/agent-runtime/` in the `ghoststack-rag` repo. Built and managed by the canonical `docker-compose.yml`.

## Service boundaries

- Browser → Caddy → `/agent-runtime/*` → this service. The browser never calls Bedrock, Odoo, or rapids directly.
- Data retrieval: `rapids-analytics:8010` (GPU cuDF mirror — preferred) and Odoo JSON-RPC (live ERP data — fallback).
- LLM: AWS Bedrock `au.anthropic.claude-opus-4-6-v1` in `ap-southeast-2`. Configured via `AGENT_RUNTIME_DEFAULT_MODEL`.
- Verification: AWS Bedrock `au.anthropic.claude-sonnet-4-6`. Configured via `AGENT_RUNTIME_VERIFIER_MODEL`.
- Storage: shared `ghostdash` Postgres (`agent_runs`, `agent_run_events`, `agent_tool_calls`, `agent_artifacts`, `agent_approvals`, `agent_verification_reviews`). Schema owned in `backend/src/ghostdash_api/schema_migrations.py`.

## What this service is NOT

- Not a replacement for `agent-ingress` (chat/voice/streaming).
- Not a second LLM gateway — uses the same Bedrock credentials already in `.env`.
- Not a standalone database — shares the GhostDASH Postgres instance.

## Tools registered

All tools are generic. No domain-specific finance functions are encoded:

| Tool | Category | Risk |
|------|----------|------|
| `catalog_data_sources` | data | read |
| `inspect_schema` | data | read |
| `query_data` | data | read |
| `execute_python` | python | write |
| `execute_bash` | shell | write (destructive cmds require approval) |
| `read_file` | filesystem | read |
| `write_file` | filesystem | write |
| `list_dir` | filesystem | read |
| `create_artifact` | filesystem | write |
| `request_approval` | meta | — |
| `submit_for_review` | verification | — |

## Observability

Every inbound HTTP request and every outbound call (Bedrock Converse, rapids `/execute`, rapids `/catalog`, Odoo JSON-RPC) emits a structured JSON log line with:

```json
{
  "trace_id": "...",
  "span_id": "...",
  "service": "agent-runtime",
  "route": "...",
  "start_ts": ...,
  "end_ts": ...,
  "latency_ms": ...,
  "status": "ok | error | <http code>",
  "error": null
}
```

`X-Trace-Id` is returned on every HTTP response. `trace_id` is persisted on `agent_runs` for run-level correlation.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_URL` | yes | Postgres connection string |
| `AWS_ACCESS_KEY_ID` | yes | Bedrock credentials |
| `AWS_SECRET_ACCESS_KEY` | yes | Bedrock credentials |
| `AWS_DEFAULT_REGION` | yes | `ap-southeast-2` |
| `AGENT_RUNTIME_DEFAULT_MODEL` | yes | Bedrock model ID for the main agent |
| `AGENT_RUNTIME_VERIFIER_MODEL` | yes | Bedrock model ID for the verifier |
| `AGENT_RUNTIME_MAX_STEPS` | no | Default 40. Max ReAct steps per run |
| `RAPIDS_URL` | yes | `http://rapids-analytics:8010` |
| `ODOO_URL` | no | Live Odoo base URL (fallback to gpu if absent/failing) |
| `ODOO_DB` | no | Odoo database name |
| `ODOO_USER` | no | Odoo login user |
| `ODOO_PASSWORD` | no | Odoo login password |

## Definition of done

- `docker compose config | grep agent-runtime` lists the service.
- `curl -s https://ghoststack.rideai.com.au/agent-runtime/health` returns `{"status":"ok"}` and `X-Trace-Id` header.
- A FY2025 P&L query reaches `agent.final` with `verification.passed`. Step count < 40.
- All outbound calls emit structured JSON log lines parseable by `jq`.
