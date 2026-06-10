# HubTiger Phase 3.1A Architecture (Strict)

## Scope

Phase 3.1A adds two deterministic behaviors:

1. `booking_create` requires schedule preflight validation before mutation.
2. `job_retrieve` includes customer message evidence (`messages`, `messages_summary`).

This phase does **not** add booking edit/reschedule mutation yet.

## Boundaries

- Public tool ingress: `POST /api/elevenlabs/hubtiger/tool`
- Control layer: `backend/src/ghostdash_api/hubtiger_mcp.py`
- MCP execution shim: `services/hubtiger-mcp/index.js`
- Portal adapter: `scripts/hubtiger/hubtiger-proxy/index.js`

No browser direct access to HubTiger APIs.

## Runtime flow

### `booking_create` (guarded)

1. Normalize function + payload.
2. Build preflight payload from booking request:
   - `store` (required)
   - `ServiceDate` or `RequiredByDate` (required)
   - `TechnicianID` (required)
   - `requiredMinutes` (optional, default `60`)
3. Execute `availability_lookup` with `cache_mode=bypass`.
4. If unavailable/invalid/slot insufficient: return `success=false`, `blocked=true`.
5. If valid: proceed with write `booking_create` via MCP `/execute`.

### `job_retrieve` (messages)

1. Retrieve job payload using current deterministic job path.
2. Resolve primary job id from result.
3. Execute `/jobs/{id}/messages` via MCP `/execute`.
4. Shape message items and attach:
   - `messages[]`
   - `messages_count`
   - `messages_summary`

## Canonical JSON contracts

## Public request envelope

```json
{
  "function": "booking_create | job_retrieve | ...",
  "store": "brisbane",
  "payload": {}
}
```

Top-level `operation` aliases are still accepted by existing normalizer.

### `booking_create` payload (minimum strict fields)

```json
{
  "function": "booking_create",
  "store": "brisbane",
  "payload": {
    "ID": 2186,
    "BikeID": 3566881,
    "ServiceTypes": [19802],
    "ServiceDate": "2026-05-07T09:00:00",
    "RequiredByDate": "2026-05-07T09:00",
    "TechnicianID": 2730,
    "PleaseBookIn": true,
    "NewJobcardID": 36022,
    "Notes": "Customer booked complete service",
    "sendCommunication": true
  }
}
```

Required for preflight gate:
- `store`
- one of `ServiceDate` / `RequiredByDate`
- one of `TechnicianID` / `technician_id` / `technicianId`

### `job_retrieve` request with messages enabled (default)

```json
{
  "function": "job_retrieve",
  "store": "southport",
  "payload": {
    "job_card_no": "#35872",
    "include_messages": true
  }
}
```

If `include_messages` omitted, default behavior is enabled.

## Public response envelope

```json
{
  "success": true,
  "message": "HubTiger call completed.",
  "operation": "job_retrieve",
  "blocked": false,
  "data": {}
}
```

### `job_retrieve` response additions

```json
{
  "messages": [
    {
      "id": 1060314,
      "direction": "Incoming",
      "channel": "sms",
      "created_at": "2026-04-30T06:57:02.127",
      "job_card_no": "035306",
      "phone": "+61435307131",
      "text": "Could you tell me how much freight would be...",
      "read": false
    }
  ],
  "messages_count": 1,
  "messages_summary": "1 message(s). Latest Incoming: Could you tell me how much freight would be..."
}
```

## Fail-closed rules

- Missing booking preflight fields: `blocked=true`, no write attempt.
- Availability preflight non-200 or invalid shape: `blocked=true`, no write attempt.
- Slot not available for requested technician/date/minutes: `blocked=true`, no write attempt.
- Message fetch failures do not leak internals; retrieval still returns safe envelope.

## Observability and safety

- Structured logs remain in existing services.
- No trace ids or secrets in public tool payload.
- Response shaping and redaction stay in `hubtiger_mcp.py`.
