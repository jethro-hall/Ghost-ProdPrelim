# HubTiger Phase 3.1B - Human Write Gate (2026-05-01)

## Requirement

Implement booking update support with a hard human-review gate so HubTiger write operations do not execute directly. Instead, queue the exact outbound API call and payload to a flat file on the server, then return:

`Success, the change will be looked at by a staff member.`

## Scope implemented

- Added canonical `booking_update` operation across HubTiger tool normalization and execute-request mapping.
- Added a human-review write gate for write operations:
  - `booking_create`
  - `booking_update`
  - `quote_add_line_item`
- Gate behavior:
  - Build exact `method`, `proxy_path`, and `proxy_body` request shape.
  - Append queued request metadata to `pending.ndjson` flat file.
  - Return blocked success with pending review envelope.
  - Do not call HubTiger MCP execute/test for those write operations.

## Flatfile queue behavior

- Preferred queue file:
  - `/data/hubtiger/write-review-queue/pending.ndjson`
- Fallback queue file if `/data` is not writable:
  - `/tmp/ghostdash/hubtiger/write-review-queue/pending.ndjson`
- Each entry includes:
  - `review_id`
  - `created_at`
  - `trace_id`
  - `status` (`pending_staff_review`)
  - `operation`
  - `message`
  - `execute_request` (exact outbound shape)
  - `payload`

## Files changed

- `backend/src/ghostdash_api/hubtiger_mcp.py`
- `backend/src/ghostdash_api/control_api.py`
- `backend/src/ghostdash_api/schemas.py`
- `backend/tests/test_hubtiger_mcp_adapter.py`
- `backend/tests/test_elevenlabs_hubtiger_ingress.py`
- `backend/tests/test_hubtiger_admin_api.py`
- `services/hubtiger-mcp/index.js`
- `services/hubtiger-mcp/index.test.js`
- `docs/HUBTIGER_ELEVENLABS_TOOL_SCHEMA_PROMPT_PACK.md`

## Architecture impact

- Moves write execution into a gated-review queue flow for HubTiger writes.
- Preserves read-only/read flows and existing retrieval behavior.
- Maintains deterministic API contract while preventing accidental live mutations.
- Keeps the queue inside server filesystem for staff approval visibility.

## Tests run

```bash
python3.12 -m pytest backend/tests/test_hubtiger_mcp_adapter.py -q
python3.12 -m pytest backend/tests/test_elevenlabs_hubtiger_ingress.py -q
python3.12 -m pytest backend/tests/test_hubtiger_admin_api.py -q
node --test services/hubtiger-mcp/index.test.js
docker compose config
```

### Test output summary

- `backend/tests/test_hubtiger_mcp_adapter.py`: **22 passed**
- `backend/tests/test_elevenlabs_hubtiger_ingress.py`: **5 passed**
- `backend/tests/test_hubtiger_admin_api.py`: **9 passed**
- `services/hubtiger-mcp/index.test.js`: **11 passed**
- `docker compose config`: **validated**

## Human verification steps

1. POST to `/api/elevenlabs/hubtiger/tool` with `function: "booking_update"` and a valid booking payload.
2. Confirm response message is exactly:
   - `Success, the change will be looked at by a staff member.`
3. Confirm response contains:
   - `success: true`
   - `blocked: true`
   - `data.review_status: pending_staff_review`
4. Confirm no live mutation request is sent to HubTiger execute endpoint.
5. Confirm new queue line appears in:
   - `/data/hubtiger/write-review-queue/pending.ndjson`
   - or fallback `/tmp/ghostdash/hubtiger/write-review-queue/pending.ndjson`

## Risks / follow-ups

- Human queue is append-only; no dequeue/approval worker is implemented yet.
- Existing write flows now return review-pending success by design; if selective gating is needed later, add operation-specific gate config.
- Next phase: implement explicit staff approval endpoint/worker to replay queued `execute_request`.
