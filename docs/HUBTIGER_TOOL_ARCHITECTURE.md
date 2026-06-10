# HubTiger Tool Architecture (Full)

## 1. Scope

This document describes the complete HubTiger tool architecture in GhostDASH:

- customer request to final response
- API contract and normalization
- MCP/proxy/runtime boundaries
- deterministic vs optional LLM usage
- safety and size controls
- observability and failure modes
- deployment/runtime topology

## 2. High-Level Architecture

### 2.1 Runtime Components

- `caddy`: HTTPS edge gateway and route entrypoint.
- `control-api`: canonical HubTiger tool endpoint owner for `/api/*`.
- `agent-ingress`: chat/voice ingress layer for `/agent/*` surfaces.
- `hubtiger-mcp`: operation router and reliability layer.
- `hubtiger-proxy`: HubTiger portal/HTTP adapter.
- HubTiger upstream APIs: external services behind proxy.

### 2.2 Primary Route Path

1. Customer asks voice/chat agent.
2. Agent emits tool call to `POST /api/elevenlabs/hubtiger/tool`.
3. `control-api` validates auth and request shape.
4. `control-api` normalizes input into canonical operation + payload.
5. `control-api` calls `hubtiger-mcp` (`/execute` preferred, `/test` fallback).
6. `hubtiger-mcp` calls `hubtiger-proxy` with deterministic `method + proxy_path + body`.
7. `hubtiger-proxy` executes HubTiger portal API calls.
8. Result returns through MCP -> control-api.
9. `control-api` applies redaction, size shaping, and safe formatting.
10. Agent converts tool JSON into customer-facing response.

## 3. API Contract Layer

### 3.1 Canonical Request Model

Primary model: `ElevenLabsHubTigerToolRequest`

Core fields:

- `function` (or legacy `operation`)
- `date`, `start_date`, `end_date`
- `store`
- `customer` `{ phone, first_name, last_name }`
- `payload` (bounded object; validated for key count and value sizes)
- optional `cache_mode` (`no_cache`/`bypass`/`fresh`) for per-request read-cache bypass

### 3.2 Function Alias Mapping

Canonical mapping examples:

- `lookup_job` -> `job_lookup`
- `job_search` -> `job_search`
- `job_retrieve` -> `job_retrieve`
- `booking_availability` -> `availability_lookup`
- `preview_quote` -> `quote_preview`
- `create_booking` -> `booking_create`

This removes drift from prompt wording differences.

## 4. Deterministic Normalization Layer

Implemented in `hubtiger_mcp` adapter:

- trims optional fields
- normalizes store aliases
- normalizes AU phone shapes
- injects customer fields into payload when missing
- enforces operation-specific required fields

Validation examples:

- `availability_lookup` requires `store + start_date/date`
- `job_search` requires customer identifier (phone/name/query)
- `job_retrieve` requires `job_id` or `job_card_no`
- `quote_preview` requires job/service id + search phrase

## 5. Execute Request Builder

Function: `build_hubtiger_execute_request()`

This converts canonical operation to MCP execute contract:

- `operation`
- `method`
- `proxy_path`
- `proxy_body`

Examples:

- `availability_lookup` -> `GET /availability/technicians?...`
- `job_lookup` with `job_id` -> `POST /jobs/search` (`q=job_id`)
- `job_lookup` without `job_id` -> `POST /jobs/search`
- `job_search` -> `POST /jobs/search`
- `job_retrieve` -> `POST /jobs/search` (`q=job_id|job_card_no`)
- `quote_preview` -> `POST /quotes/find-add` (dry run style path)

No free-form routing from LLM is trusted at this layer.

## 6. MCP Layer Responsibilities

`hubtiger-mcp` responsibilities:

- stable execution interface for `control-api`
- read-operation retry behavior
- circuit state handling
- optional caching for read operations
- structured operation metadata (status/latency/circuit/cache flags)

It is a reliability shim between backend and portal adapter.

## 7. Proxy Layer Responsibilities

`hubtiger-proxy` responsibilities:

- HubTiger portal mode auth and token use
- upstream endpoint specifics and payload translation
- per-feature route handlers:
  - job search / job read
  - availability
  - customer/bike/booking helpers
  - quote preview and line item operations

The proxy owns HubTiger API peculiarities so they do not leak into `control-api`.

## 8. Best-Practice Hardening Applied

### 8.1 Request Guards

- operation-specific payload allowlists
- payload key count and field length limits
- search text caps

### 8.2 Response Guards

- row/result list caps
- string truncation for oversized fields
- hard maximum payload size with fallback truncation envelope
- credential-like key redaction before public return

### 8.3 Window Control

- availability default date window reduced when no `end_date` is supplied to reduce latency and payload volume.

## 9. Deterministic vs LLM Responsibilities

### 9.1 Deterministic (required)

- auth validation
- schema validation
- function mapping
- operation routing
- payload shaping
- size limits
- redaction
- write-mode blocking

### 9.2 Optional Local LLM (narrow utility)

Used only for oversized simple query compaction:

- scope: `job_lookup`/`quote_preview` query text
- purpose: shorten noisy user text into compact lookup phrase
- constraints: low token cap, short timeout, deterministic fallback if unavailable

No architectural routing decisions are delegated to this LLM path.

## 10. Access Modes and Write Safety

`HUBTIGER_TOOL_ACCESS` modes:

- `read_only`:
  - allows read operations
  - write operations (`booking_create`, `booking_update`, `quote_add_line_item`) still **queue for staff review** after schedule preflight; they do not call HubTiger `/bookings` until approved
- `read_write`:
  - enables staff approval replay; live execute only when `HUBTIGER_BOOKING_AUTO_EXECUTE=true` and approve succeeds

`HUBTIGER_BOOKING_AUTO_EXECUTE` (default `false`): when `true` with `read_write`, staff approve replays the queued execute request to HubTiger MCP.

Public ElevenLabs read tools stay on `POST /api/elevenlabs/hubtiger/tool`. `booking_create` uses `POST /api/elevenlabs/hubtiger/booking_create` after sign-off.

Blocking and preflight happen in `hubtiger_mcp` before any proxy mutation call.

## 11. Observability

### 11.1 Trace Propagation

- incoming `trace_id` accepted/created at API layer
- forwarded through MCP and proxy via headers
- returned on responses where applicable

### 11.2 Structured Logging

Control API and proxy paths emit structured logs including:

- trace identifiers
- route
- latency
- status
- error (if any)

### 11.3 Recent Trace Surface

- recent HubTiger traces are kept for diagnostics endpoint access in control-api.

## 12. Error Model and Fallbacks

Typical error classes:

- validation errors (422)
- unavailable upstream/mcp/proxy (mapped to safe unavailable responses)
- blocked write attempts in read-only mode
- quote preview upstream dependency failures

Customer surfaces should only receive safe, action-oriented messages.

## 12.1 Store Ambiguity Guardrail

For job search/retrieve, response shaping should include store disambiguation metadata:

- `store_requested`
- `store_matched`
- `store_match`
- `selection_required`
- `allowed_next_actions`

If `store_match=false`, the presenter must fail closed and ask for clarification instead of asserting branch-specific certainty.

## 13. Current Known Constraint

`quote_preview` may fail when product sync/search upstream dependency is unavailable (`portal_products_sync_failed` chain).  
This is an upstream dependency reliability issue, not function mapping drift.

## 14. Security and Data Safety

- secret-like keys are removed/redacted from outbound data
- internal traces/errors are not exposed in public response text
- browser and voice clients remain behind controlled API boundaries

## 15. Sequence Diagrams

### 15.1 Job Search + Retrieve

1. Agent -> `control-api` (`job_search`)
2. `control-api` -> normalize + build execute request
3. `control-api` -> `mcp /execute`
4. `mcp` -> `proxy /jobs/search`
5. Agent selects specific case -> `job_retrieve`
6. `control-api` -> `mcp` -> `proxy /jobs/search` with selected identifier
7. Response -> shape/redact/limit -> agent response

### 15.2 Availability

1. Agent -> `control-api` (`booking_availability`)
2. normalize store/date
3. build `/availability/technicians` execute path
4. `mcp` -> `proxy` -> HubTiger API
5. response row-cap + earliest slot summary
6. agent outputs concise availability options

### 15.3 Quote Preview

1. Agent -> `control-api` (`quote_preview`)
2. validate `job_id + search`
3. build `/quotes/find-add` execute path
4. `mcp` -> `proxy` quote flow
5. proxy product search/invoice lookup
6. success preview or controlled unavailable response

## 16. Configuration Surface

Primary runtime knobs (backend):

- `HUBTIGER_MCP_URL`
- `HUBTIGER_TOOL_ACCESS`
- `hubtiger_read_timeout_ms`
- `hubtiger_mutation_timeout_ms`
- `hubtiger_max_search_chars`
- `hubtiger_max_rows`
- `hubtiger_max_matches`
- `hubtiger_max_field_chars`
- `hubtiger_max_payload_chars`
- `hubtiger_enable_local_simple_llm`
- `hubtiger_simple_llm_timeout_ms`
- `hubtiger_simple_llm_max_tokens`

Primary runtime knobs (proxy):

- `HUBTIGER_PORTAL_MODE`
- portal credentials/token envs
- max search/result caps for proxy route handlers

## 17. Test Strategy

Required test slices:

- canonical happy path by function
- validation failures (missing required fields)
- unavailable upstream path
- read-only write blocking
- payload-size and result-cap behavior
- no internal leakage in public responses

## 18. Recommended Next Improvements

1. Add deterministic stale-cache fallback for quote product search.
2. Add contract tests covering max-size truncation behavior.
3. Add explicit operator response templates per function for voice consistency.
