# HubTiger Operator Playbook

## Purpose

This playbook is the operator-facing guide for HubTiger tool usage in GhostDASH and Magic Mike.  
It maps customer requests to canonical tool functions, required fields, expected backend behavior, and safe response patterns.

## Canonical Tool Endpoint

- URL: `POST /api/elevenlabs/hubtiger/tool`
- Production URL: `https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`
- Availability alias URL: `https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/booking_availability`
- Auth: `X-Ghost-Voice-Key` or `Authorization: Bearer`
- Body shape (minimal):
  - `function`
  - `store` and/or `date` fields depending on function
  - `customer` and `payload` as needed

### Cache behavior

- Public tool calls use one canonical endpoint (`/api/elevenlabs/hubtiger/tool`).
- Separate public `cache` and `no-cache` Hubtiger tool URLs are not currently implemented.
- Caching is governed server-side by MCP runtime environment settings.

Example:

```json
{
  "function": "lookup_job",
  "store": "southport",
  "customer": { "phone": "0435185134" },
  "payload": {}
}
```

## Function Map (Customer Intent -> Function)

- "Find my jobs" -> `job_search`
- "Open this specific job card" -> `job_retrieve`
- "When can I book in?" -> `booking_availability`
- "Can you preview quote for brake pads?" -> `quote_preview`
- "Book it in now" -> `booking_create` (blocked in read-only mode)
- "Add this line item to quote" -> `quote_add_line_item` (blocked in read-only mode)

## ElevenLabs Workflow Tool Usage (Ready Template)

Use this workflow when configuring an ElevenLabs agent that calls GhostDASH HubTiger tools.

### Shared tool endpoint

- URL: `POST /api/elevenlabs/hubtiger/tool`
- Auth: `X-Ghost-Voice-Key` or `Authorization: Bearer`
- Required top-level key: `function`
- Optional helpers: `store`, `date`, `start_date`, `end_date`, `cache_mode`, `customer`, `payload`

### Workflow state machine

1. Identify intent: job check, booking, quote, or write action.
2. Collect only minimum required fields for that function.
3. Call one tool at a time in deterministic order.
4. Convert result to short customer-safe response.
5. If result is blocked or unavailable, offer one concrete next step.

### No-cache retry workflow (LLM how-to-use)

Use no-cache retry only for read operations:

- `job_search`
- `job_retrieve`
- `booking_availability`
- `quote_preview`

When first response looks stale or inconsistent, rerun once with `cache_mode: "no_cache"`.

Known issue patterns where no-cache retry helps:

- customer reports a just-sent SMS/status update but tool returns previous state
- first lookup returns empty despite valid identifier from customer
- availability appears unchanged immediately after reschedule or booking event
- quote preview appears stale after recent line-item or parts updates
- transient upstream issues cached briefly and next turn needs a fresh read

Example retry:

```json
{
  "function": "job_retrieve",
  "store": "southport",
  "cache_mode": "no_cache",
  "payload": { "job_card_no": "#35872" }
}
```

If you receive `Lookup-only mode supports \`lookup_job\`.` from `/api/elevenlabs/hubtiger/tool`, the deployed control-api is stale and needs the updated build/restart before retrieve/search/no-cache flows are available on that API path.

### Store ambiguity contract (production safety)

When search/retrieve results are ambiguous across stores, tool data should include:

```json
{
  "store_requested": "brisbane",
  "store_matched": "southport",
  "store_match": false,
  "selection_required": true,
  "allowed_next_actions": ["clarify_store", "list_matching_cases"]
}
```

Operator/LLM rule:

- If `store_match` is `false`, do not present branch-specific certainty.
- Ask for store clarification or job card selection before continuing.
- Distinguish store states:
  - `store_verification="matched"` -> requested store confirmed
  - `store_verification="mismatch"` -> requested store conflicts with matched store
  - `store_verification="unknown"` -> store not exposed by upstream payload

Exact identifier exception:

- For one exact `job_card_no` match, `selection_required` can be `false` even when `store_verification="unknown"`.
- Do not force extra store clarification when exact identifier confidence is already `exact`.

### Workflow A: Existing job check (two-step, preferred)

Step A1: Search list

```json
{
  "function": "job_search",
  "store": "southport",
  "customer": { "phone": "0435185134" },
  "payload": {}
}
```

Step A2: Retrieve selected case

```json
{
  "function": "job_retrieve",
  "store": "southport",
  "payload": { "job_card_no": "#35872" }
}
```

Voice behavior:
- If multiple cases return, ask which job card to open.
- Ask one question only.

### Workflow B: New booking availability then submit

Step B1: Availability lookup

```json
{
  "function": "booking_availability",
  "store": "brisbane",
  "start_date": "2026-04-30",
  "payload": {}
}
```

Step B2: Booking create (only when write mode is enabled)

```json
{
  "function": "booking_create",
  "store": "brisbane",
  "payload": {
    "first_name": "Sam",
    "last_name": "Rider",
    "mobile": "0435123456",
    "bike_brand": "Fatfish",
    "bike_model": "Fatfish OG",
    "start": "2026-04-30T10:00:00+10:00"
  }
}
```

Voice behavior:
- In `read_only` mode, do not claim the booking is completed.
- Offer to connect booking support or capture details for callback.

### Workflow C: Quote flow (strict order)

Step C1: Preview first

```json
{
  "function": "quote_preview",
  "store": "southport",
  "payload": { "job_id": "4200325", "search": "brake pads" }
}
```

Step C2: Add line item only after preview success

```json
{
  "function": "quote_add_line_item",
  "store": "southport",
  "payload": { "job_id": "4200325", "invoice_item_id": "12345", "qty": 1 }
}
```

Voice behavior:
- If preview is unavailable, keep response short and action-oriented.
- Offer one next step (team follow-up or callback).

### Workflow D: Guardrails and fail-closed behavior

- Never expose traces, backend errors, internal diagnostics, or tool internals.
- Never claim booking, quote, availability, or job outcome without tool success.
- If legal/compliance question is asked and approved source is missing, use legal fallback wording and offer handoff.
- For unknown price/stock/availability/job status, do not guess; offer to check now.

### ElevenLabs agent prompt block (copy/paste)

Use GhostDASH HubTiger tools in deterministic order.
For existing job queries, call job_search first, then job_retrieve with selected job_card_no or job_id.
For new bookings, call booking_availability before booking_create.
For quote flows, call quote_preview before quote_add_line_item.
Call one tool at a time and ask one question at a time.
If a tool is blocked, unavailable, or missing required evidence, do not guess and do not expose internals; offer one clear next action.
Keep spoken responses short, conversational, and action-oriented.

## Per-Function Workflow

### 1) `job_search` (canonical operation: `job_search`)

**Minimum input**
- `function=job_search`
- one customer identifier:
  - `customer.phone`, or
  - customer name fields, or
  - `payload.query`

**Runtime behavior**
1. Backend normalizes fields and trims excess.
2. Deterministic query builder selects best identifier.
3. Routes to MCP:
   - `POST /jobs/search` using customer identifier.
4. Results are size-limited and redacted before returning.
5. LLM crafts short customer response.

**Operator response target**
- Job card number
- Status
- Last update
- ask which job card should be opened when multiple cases are returned

### 2) `job_retrieve` (canonical operation: `job_retrieve`)

**Minimum input**
- `function=job_retrieve`
- selected job identifier:
  - `payload.job_card_no`, or
  - `payload.job_id`

**Runtime behavior**
1. Backend validates selected case identifier.
2. Deterministic mapper routes to `POST /jobs/search` with selected identifier.
3. Response is trimmed and shaped into a single-case result where possible.
4. LLM responds with concise selected-case details and next step.

### 3) `booking_availability` (canonical operation: `availability_lookup`)

**Minimum input**
- `function=booking_availability`
- `store`
- `start_date` or `date`

**Runtime behavior**
1. Backend validates required fields.
2. Deterministic mapper builds availability request.
3. Default availability window is constrained when `end_date` is absent.
4. Proxy fetches technician availability from portal APIs.
5. Rows are capped and an `earliest` slot summary is included.
6. LLM returns concise booking options.

**Operator response target**
- Earliest available slot
- Store confirmation
- One clear prompt to confirm booking preference

### 4) `quote_preview` (canonical operation: `quote_preview`)

**Minimum input**
- `function=quote_preview`
- `payload.job_id` (or service id alias)
- `payload.search` (part/service text)

**Runtime behavior**
1. Backend trims and validates search text.
2. Optional local LLM compacts oversized search phrases to a short lookup phrase.
3. Deterministic route calls quote preview chain through MCP/proxy.
4. Proxy attempts product lookup + invoice context.
5. If upstream product sync is unavailable, returns controlled unavailable response.

**Operator response target**
- If successful: preview line item summary + ask for approval.
- If unavailable: explain delay and offer follow-up/handoff.

### 5) `booking_create` and `quote_add_line_item`

**Current mode**
- Schedule preflight runs before queueing (store + date + technician + slot minutes).
- Writes queue to staff review (`pending_staff_review`); no live HubTiger mutation until staff approve.
- Live execute only when `HUBTIGER_TOOL_ACCESS=read_write` and `HUBTIGER_BOOKING_AUTO_EXECUTE=true`.

**Expected behavior**
- Public voice message: workshop team will confirm (not “you are booked”) unless `booking_confirmed: true`.
- Operator review: `GET /api/hubtiger/write-reviews`, `POST .../approve`, `POST .../reject`.

## Input Rules and Limits

- Payload keys are allowlisted per function.
- Unknown/unneeded fields are ignored before routing.
- Search fields are trimmed to bounded size.
- Response arrays and payload size are bounded before returning to voice/chat.

## Customer-Safe Response Rules

- Do not expose traces, backend internals, or gateway errors.
- If operation is unavailable, offer one concrete next action.
- Keep voice responses short and action-oriented.
- Do not guess status, stock, booking outcomes, or legal/compliance claims.

## Baseline: agent-path `booking_create` queue (Phase 0)

Writes queue for staff review and do not call HubTiger `/bookings` until approved (when auto-execute is enabled).

```bash
curl -sS -X POST "https://ghoststack.rideai.com.au/agent/integrations/elevenlabs/hubtiger/tool" \
  -H "Authorization: Bearer ${APP_VOICE_INGRESS_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "function": "booking_create",
    "store": "brisbane",
    "payload": {
      "ID": 2186,
      "BikeID": 3566881,
      "ServiceTypes": [19802],
      "ServiceDate": "2026-05-22T10:00:00",
      "TechnicianID": 2730,
      "PleaseBookIn": true,
      "Notes": "Baseline queue test"
    }
  }'
```

Expect: `success: true`, `blocked: true`, `data.review_status: pending_staff_review`, `data.booking_confirmed: false`. No live booking mutation.

## Fast Troubleshooting

1. Confirm endpoint health:
   - `GET /health`
2. Confirm tool route:
   - `POST /api/elevenlabs/hubtiger/tool`
3. Validate function fields:
   - job lookup needs one identifier
   - availability needs store + date
   - quote preview needs job/service id + search
4. If quote preview fails with unavailable:
   - likely upstream product sync lane issue (known dependency)

## Deployment parity checks (before production validation)

```bash
docker compose up -d --build control-api hubtiger-mcp
docker compose images control-api hubtiger-mcp
docker inspect ghoststack-rag-control-api-1 --format '{{.Image}}'
docker inspect ghoststack-rag-hubtiger-mcp-1 --format '{{.Image}}'
```

If `/api/elevenlabs/hubtiger/tool` still returns lookup-only `422`, production is running a stale `control-api` image; rebuild/restart `control-api` and verify again.

## Smoke Test Commands

```bash
curl -sS -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: <SECRET>" \
  -d '{"function":"job_search","store":"southport","customer":{"phone":"0435185134"},"payload":{}}'
```

```bash
curl -sS -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: <SECRET>" \
  -d '{"function":"job_retrieve","store":"southport","payload":{"job_card_no":"#35872"}}'
```

```bash
curl -sS -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: <SECRET>" \
  -d '{"function":"booking_availability","store":"brisbane","start_date":"2026-04-29","payload":{}}'
```

```bash
curl -sS -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: <SECRET>" \
  -d '{"function":"quote_preview","store":"southport","payload":{"job_id":"4200325","search":"brake pads"}}'
```
