# Hubtiger ElevenLabs Tool Schema + Prompt Pack

This pack is copy/paste-ready for configuring an ElevenLabs agent to call GhostDASH Hubtiger tools safely and deterministically.

## 0) ElevenLabs import JSON files (repo)

Import via **Conversational AI → Agent → Tools → Add tool → Import JSON** (paste file contents).

| Tool | Primary path |
|------|----------------|
| Customer by phone (fast caller ID + open job) | `scripts/hubtiger/hubtiger_customer_by_phone.json` |
| Job search (status / visibility step 1) | `scripts/hubtiger/hubtiger_job_search.json` |
| Job retrieve (status step 2) | `scripts/hubtiger/hubtiger_job_get.json` |
| Booking availability | `scripts/hubtiger/hubtiger_booking_availability.json` |

Mirrors: `scripts/hubtiger/hubtiger-api/elevenlabs-tools/*.json`
Download bundle: `scripts/hubtiger/hubtiger-api/elevenlabs-tools-download/*.json`

After import, set header `X-Ghost-Voice-Key` from GhostDASH `.env` (`ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` or `APP_VOICE_INGRESS_SECRET`). Do not commit live keys in JSON.

For email agents: attach **both** `hubtiger_job_search` and `hubtiger_job_retrieve`; put the sender email in `payload.query` when no phone is known.

## 1) Tool endpoint contract

- URL: `POST /api/elevenlabs/hubtiger/tool`
- Production URL: `https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`
- Auth header: `X-Ghost-Voice-Key: <SECRET>` or `Authorization: Bearer <SECRET>`
- Content type: `application/json`
- Response model: `PublicToolResult` (`success`, `message`, `operation`, `blocked`, `data`)
- Availability alias (narrow helper path): `https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/booking_availability`

### Cache and no-cache note

- There is currently one canonical tool URL for Hubtiger tool calls: `https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`.
- Separate `cache` and `no-cache` public URLs are not implemented for this tool surface.
- Cache behavior is controlled by runtime settings in the MCP layer (for example `HUBTIGER_MCP_CACHE_PROFILE`, `HUBTIGER_MCP_CACHE_DIRECTION`, and per-operation TTL envs), not by switching endpoint paths.

## 2) ElevenLabs tool schema (copy/paste)

Use this as your custom tool parameter schema.

```json
{
  "type": "object",
  "properties": {
    "function": {
      "type": "string",
      "description": "Canonical function name. Prefer: job_search, job_retrieve, booking_availability, quote_preview, booking_create, booking_update, quote_add_line_item. Legacy aliases like lookup_job are accepted but should be avoided."
    },
    "operation": {
      "type": "string",
      "description": "Optional legacy field. Use function instead when possible."
    },
    "cache_mode": {
      "type": "string",
      "description": "Optional diagnostic cache hint. Normal job_retrieve validates cache and falls back to fresh server-side; leave blank for regular ElevenLabs calls."
    },
    "store": {
      "type": "string",
      "description": "Store slug or spoken alias mapped server-side (for example southport, brisbane, burleigh)."
    },
    "date": {
      "type": "string",
      "description": "Optional date shortcut when a function accepts date input."
    },
    "start_date": {
      "type": "string",
      "description": "Preferred start date for availability lookups (YYYY-MM-DD)."
    },
    "end_date": {
      "type": "string",
      "description": "Optional end date to define a search window."
    },
    "customer": {
      "type": "object",
      "properties": {
        "phone": { "type": "string" },
        "first_name": { "type": "string" },
        "last_name": { "type": "string" }
      },
      "additionalProperties": false
    },
    "payload": {
      "type": "object",
      "description": "Function-specific fields. Keep payload compact and task-focused.",
      "additionalProperties": true
    }
  },
  "required": ["function"],
  "additionalProperties": false
}
```

## 3) Function routing rules (must follow)

- Existing job flow: `job_search` -> `job_retrieve`
- Booking flow: `booking_availability` -> `booking_create` or `booking_update`
- Quote flow: `quote_preview` -> `quote_add_line_item`
- One tool call at a time.
- Ask one focused follow-up question at a time.
- For `job_retrieve`, use the normal tool. It validates cached job payloads and falls back to fresh server-side when cache is bad.

## 4) Prompt pack (copy/paste)

**Recommended:** use the full master prompt in [`MAGIC_MIKE_HUBTIGER_AGENT_SYSTEM_PROMPT.md`](./MAGIC_MIKE_HUBTIGER_AGENT_SYSTEM_PROMPT.md) (booking availability, job visibility, **Mon–Sat 8:30am–5:00pm** guardrails).

Short pack (legacy) — use this in the ElevenLabs agent instruction area if you need a minimal block:

```text
You are Magic Mike, Ride Electric's service assistant.
Use GhostDASH Hubtiger tool calls as the evidence source for bookings, job status, and quotes.

WORKSHOP HOURS
Monday–Saturday only, 8:30am–5:00pm (Brisbane). Never offer or submit bookings outside these hours.

TOOL DISCIPLINE
- Always call POST /api/elevenlabs/hubtiger/tool with JSON input.
- Use canonical functions: job_search, job_retrieve, booking_availability, quote_preview, booking_create, booking_update, quote_add_line_item.
- Use normal job_retrieve for selected jobs. It validates cache and falls back to fresh/no-cache server-side, so do not manually call a no-cache variant during normal customer calls.
- Existing jobs must use two-step flow: job_search first, then job_retrieve with selected job_card_no or job_id.
- Booking must use booking_availability before booking_create.
- booking_create is schedule-guarded: include store + ServiceDate/RequiredByDate + TechnicianID so slot preflight can be validated.
- booking_create, booking_update, and quote_add_line_item are human-gated write operations. The API returns: "Success, the change will be looked at by a staff member."
- Quote must use quote_preview before quote_add_line_item.
- Never claim success unless the tool result says success=true.
- If blocked=true or success=false, do not guess; offer one concrete next step.

PUBLIC RESPONSE RULES
- Keep voice replies short, conversational, and action-oriented.
- Never expose internal errors, traces, tool internals, or diagnostics.
- If price, stock, availability, booking outcome, or job status is not confirmed by tool output, say you can check now and ask one required follow-up.
- Never claim Ride Electric is missing from context.
- Prefer Ride Electric supported brands: Smartmotion, Zero, VSETT, Fatfish.
- For legal/road-rule questions, use approved source only; otherwise give the safe fallback and offer handoff.
```

## 5) Ready request examples

### Existing job list

```json
{
  "function": "job_search",
  "store": "southport",
  "customer": { "phone": "0435185134" },
  "payload": {}
}
```

### Retrieve selected case

```json
{
  "function": "job_retrieve",
  "store": "southport",
  "payload": { "job_card_no": "#35872" }
}
```

`job_retrieve` now includes `messages`, `messages_count`, and `messages_summary` when available.

### Booking availability

```json
{
  "function": "booking_availability",
  "store": "brisbane",
  "start_date": "2026-04-30",
  "payload": {}
}
```

### Booking create (ScheduleService payload)

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

### Booking update (human approval gate)

```json
{
  "function": "booking_update",
  "store": "brisbane",
  "payload": {
    "id": 4200325,
    "ServiceDate": "2026-05-22T10:00:00",
    "RequiredByDate": "2026-05-22T10:00",
    "TechnicianID": 2730,
    "Notes": "Customer requested new time slot",
    "sendCommunication": true
  }
}
```

### Quote preview

```json
{
  "function": "quote_preview",
  "store": "southport",
  "payload": { "job_id": "4200325", "search": "brake pads" }
}
```

## 6) Quick QA checklist

1. Unknown job query triggers `job_search`, not booking functions.
2. Multi-job results ask for selected job card before retrieval.
3. Booking or quote write attempt returns the human-review success message and does not claim upstream mutation success.
4. No internal diagnostics appear in spoken output.
5. Voice response stays concise with one action/question.

## 7) Job retrieve cache fallback and no-cache diagnostics

Normal `hubtiger_job_retrieve` self-heals from bad cache before returning to ElevenLabs. The MCP layer validates cached job retrieval payloads for usable business data; if cache is empty, stale, structurally incomplete, or contains an unavailable/error placeholder, it calls the existing fresh/no-cache path internally and returns one clean result.

### What the normal tool returns

- `business_success: true` when usable job data was returned.
- `source: "cache"` or `source: "fresh"`.
- `fallback_used: true` when a cached payload was rejected and fresh succeeded.
- `cache_reject_reason` when fallback was triggered.
- `business_success: false` with safe `user_message` when cache and fresh both fail validation.

### Log fields for fallback detection

Look in `hubtiger-mcp` request logs for:

- `cache_hit`
- `cache_valid`
- `cache_reject_reason`
- `fallback_used`
- `fresh_valid`
- `fresh_reject_reason`

### No-cache diagnostic use only

Keep the no-cache path/tool for operator debugging or explicit manual diagnostics. The LLM should normally call `hubtiger_job_retrieve` without `cache_mode`.

Use `cache_mode: "no_cache"` only when an operator is intentionally bypassing cache to compare behavior:

```json
{
  "function": "job_retrieve",
  "store": "southport",
  "cache_mode": "no_cache",
  "payload": { "job_card_no": "#35872" }
}
```

### Secret rotation reminder

If `X-Ghost-Voice-Key` is pasted into chat, logs, tickets, or screenshots, rotate `ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` in GhostDASH `.env`, recreate the control-api container, and update the ElevenLabs tool header.

### Identifier disambiguation safeguards

- If input is weak/ambiguous (for example `1234`), do not assume it is a job card.
- Ask whether it is a job card number or phone fragment before retrieval.
- If only a first name is provided, request one stronger identifier (surname, full phone, job card, or store) before proceeding.

## 8) Store ambiguity guardrail (must enforce)

For job search/retrieve with store context, treat these fields as authoritative:

- `store_requested`
- `store_matched`
- `store_match`
- `selection_required`
- `allowed_next_actions`

Required behavior:

- If `store_match=false`, never claim branch-specific certainty.
- Ask for clarification or explicit case selection before giving definitive status.

### If you still get 422 lookup-only error

If the API returns `{"detail":"Lookup-only mode supports \`lookup_job\`."}`, the running `control-api` is on an older build.

Deploy/restart with the current build so `/api/elevenlabs/hubtiger/tool` accepts:

- `job_search`
- `job_retrieve`
- `booking_availability`
- `quote_preview`
