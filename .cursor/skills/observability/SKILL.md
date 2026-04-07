---
name: observability
description: Enforce structured JSON logging, trace propagation, and latency measurement across GhostDASH API and worker code.
---

# Skill: Observability Instrumentation

## Logging schema

Every inbound request and outbound call must log:

- `trace_id`
- `span_id`
- `service`
- `route`
- `start_ts`
- `end_ts`
- `latency_ms`
- `status`
- `error`

## Recommended approach

1. Add middleware for inbound API tracing.
2. Wrap outbound calls to:
   - `llama-stack`
   - `qdrant`
   - `LlamaParse`
3. Return trace IDs to clients where useful.
4. If an API request creates async worker work, persist and reuse the same `trace_id` in the task payload and all worker-side outbound calls.

## Verification

- Exercise `GET /health` and one `/api/*` route.
- Confirm JSON logs contain all required fields.
- Run `python3.12 -m compileall backend/src`
