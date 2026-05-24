# Hubtiger ElevenLabs Tool Schema + Prompt Pack

This pack is copy/paste-ready for configuring an ElevenLabs agent to call GhostDASH Hubtiger tools safely and deterministically.

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
      "description": "Canonical function name. Prefer: job_search, job_retrieve, booking_availability, quote_preview, booking_create, quote_add_line_item. Legacy aliases like lookup_job are accepted but should be avoided."
    },
    "operation": {
      "type": "string",
      "description": "Optional legacy field. Use function instead when possible."
    },
    "cache_mode": {
      "type": "string",
      "description": "Optional cache hint. Use no_cache (or bypass/fresh) to force a fresh read attempt for read operations."
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
- Booking flow: `booking_availability` -> `booking_create`
- Quote flow: `quote_preview` -> `quote_add_line_item`
- One tool call at a time.
- Ask one focused follow-up question at a time.
- If a read result looks stale or inconsistent, retry once with `cache_mode: "no_cache"`.

## 4) Prompt pack (copy/paste)

Use this in the ElevenLabs agent instruction area:

```text
You are Magic Mike, Ride Electric's service assistant.
Use GhostDASH Hubtiger tool calls as the evidence source for bookings, job status, and quotes.

TOOL DISCIPLINE
- Always call POST /api/elevenlabs/hubtiger/tool with JSON input.
- Use canonical functions: job_search, job_retrieve, booking_availability, quote_preview, booking_create, quote_add_line_item.
- If a read call looks stale, retry once with cache_mode=no_cache.
- Existing jobs must use two-step flow: job_search first, then job_retrieve with selected job_card_no or job_id.
- Booking must use booking_availability before booking_create.
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

### Booking availability

```json
{
  "function": "booking_availability",
  "store": "brisbane",
  "start_date": "2026-04-30",
  "payload": {}
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
3. Booking write attempt in read-only mode returns safe next-step wording.
4. No internal diagnostics appear in spoken output.
5. Voice response stays concise with one action/question.

## 7) No-cache retry workflow (how to use)

Use a no-cache retry only for read operations (`job_search`, `job_retrieve`, `booking_availability`, `quote_preview`) when the first response looks suspect.

### When to try no-cache

- Customer says they just received an update but tool returns old status.
- First read returns no results, but customer confirms exact job card/phone that previously worked.
- Availability response looks outdated immediately after a booking/reschedule.
- Quote preview appears out of date after recent parts or line-item changes.
- A transient upstream issue was seen and the next turn needs a fresh check.

### Identifier disambiguation safeguards

- If input is weak/ambiguous (for example `1234`), do not assume it is a job card.
- Ask whether it is a job card number or phone fragment before retrieval.
- If only a first name is provided, request one stronger identifier (surname, full phone, job card, or store) before proceeding.

### Retry pattern

1. Run normal read call first (default cache mode).
2. If suspicious, rerun the same call with:

```json
{
  "function": "job_retrieve",
  "store": "southport",
  "cache_mode": "no_cache",
  "payload": { "job_card_no": "#35872" }
}
```

3. Use the second result as current evidence for customer wording.
4. If still unavailable, give one concrete fallback action (callback/handoff/manual confirmation).

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
