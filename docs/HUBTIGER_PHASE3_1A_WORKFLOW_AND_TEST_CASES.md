# HubTiger Phase 3.1A Workflow and Test Cases

## Operator workflow (strict)

## A) Create booking (guarded)

1. Collect required fields:
   - `store`
   - `ServiceDate` (or `RequiredByDate`)
   - `TechnicianID`
   - booking body fields (`ID`, `BikeID`, `ServiceTypes`, etc.)
2. Call `booking_create`.
3. System runs schedule preflight automatically.
4. If blocked, ask customer for another slot/technician/date.
5. If success, confirm booking outcome from tool response only.

## B) Retrieve job with messages

1. Run `job_search` when needed for disambiguation.
2. Run `job_retrieve` with selected `job_card_no`/`job_id`.
3. Read `messages_summary` and latest `messages[]` for customer-facing updates.
4. If no messages, state that none are currently visible and offer next step.

## JSON patterns that reduce errors

### Good (`booking_create`)

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

### Good (`job_retrieve` + messages)

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

### Bad (will block/fail)

```json
{
  "function": "booking_create",
  "payload": {
    "ServiceDate": "2026-05-07T09:00:00"
  }
}
```

Why bad: missing `store` + `TechnicianID` for preflight.

## Acceptance criteria

1. Booking write is blocked unless slot is validated for store/date/technician.
2. Retrieval includes structured message evidence when available.
3. Public response never exposes internal diagnostics.
4. Tool output stays concise and action-oriented for voice.

## Automated test cases (implemented)

1. Booking preflight payload requires `store`, date, technician.
2. Booking preflight payload normalizes store/date/technician.
3. Slot availability evaluator validates technician/date/minutes.
4. Existing hubtiger tool + ingress suites still pass.

## Human QA test matrix

### 1) Happy path booking
- Input valid `booking_create` with known available technician/date.
- Expected: `success=true`, `blocked=false`.

### 2) Missing required booking field
- Remove `store` or `TechnicianID`.
- Expected: `success=false`, `blocked=true`, clear next-step message.

### 3) Slot unavailable
- Use technician/date with insufficient availability.
- Expected: `success=false`, `blocked=true`, slot-unavailable message.

### 4) Upstream availability down
- Simulate availability endpoint failure.
- Expected: blocked-safe response, no mutation performed.

### 5) Retrieve with messages
- `job_retrieve` on job with messages.
- Expected: `messages[]`, `messages_count`, `messages_summary` populated.

### 6) Retrieve with no messages
- `job_retrieve` on job with no messages.
- Expected: empty `messages`, `messages_count=0`, explicit no-message summary.

### 7) Voice safety check
- Verify customer response text does not include stack traces/diagnostics.

## Verify commands

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 -m pytest backend/tests/test_hubtiger_mcp_adapter.py -q
python3.12 -m pytest backend/tests/test_hubtiger_elevenlabs_tool.py -q
python3.12 -m pytest backend/tests/test_elevenlabs_hubtiger_ingress.py -q
node --test services/hubtiger-mcp/index.test.js
docker compose config
```
