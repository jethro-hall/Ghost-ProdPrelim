# HubTiger booking — two-tool ElevenLabs map (availability + create)

Use this when your **working** tools are the brand-new pair:

| File | Tool name in ElevenLabs | API `function` |
|------|-------------------------|----------------|
| `scripts/hubtiger/hubtiger_booking_availability.json` | `hubtiger_booking_availability_readonly` | `booking_availability` |
| `scripts/hubtiger/hubtiger_booking_create.json` | `hubtiger_booking_create` | `booking_create` |

Copies: `scripts/hubtiger/hubtiger-api/elevenlabs-tools/` (same filenames).

**Webhook (both tools):**

- URL: `https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`
- Header: `X-Ghost-Voice-Key` = GhostDASH `ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` or `APP_VOICE_INGRESS_SECRET`

**Staged flow (8 tools + `booking_session_id`)** is optional for frustrated callers or long calls — see `docs/HUBTIGER_BOOKING_WORKFLOW_NODES.md`. This doc is the **simple 2-tool** path that matches your tested JSON files.

---

## Workflow shape (3 nodes)

```mermaid
flowchart LR
  A[1 Availability] --> B[2 Collect details]
  B --> C[3 Book create]
  C --> D[4 Done]
```

| Node ID | Type | Tool attached | Purpose |
|---------|------|---------------|---------|
| `booking_availability` | **Tool** | `hubtiger_booking_availability_readonly` only | Find ≤3 in-hours slots |
| `booking_collect` | **Conversation** | **None** | Name, mobile, bike, service, issue; confirm slot |
| `booking_create` | **Tool** | `hubtiger_booking_create` only | One-shot write to HubTiger |
| `booking_complete` | **Conversation** | **None** | SMS / staff-review closing lines |

**Rules**

1. **One tool per tool node** — never attach both tools on one node.
2. **Do not** call `hubtiger_booking_create` until the customer accepted a slot from availability.
3. Speak **`message`** / **`voice_line`** only — never raw JSON or errors.
4. Mon–Sat **8:30am–5:00pm** Brisbane only; never invent times if `slot_count` is 0.

Node prompts (copy into ElevenLabs): `scripts/hubtiger/workflow-prompts/NODE_SIMPLE_*.md`

---

## ElevenLabs dynamic variables

Create these **workflow variables** (Settings → Dynamic variables):

| Variable | When to set | Source in tool response |
|----------|-------------|-------------------------|
| `booking_store` | After availability (or at start if customer said store) | Request `store` you used, or `data.store` |
| `booking_service_date` | Customer picks recommended or backup slot | `data.recommended_slot.ServiceDate` or chosen backup’s `ServiceDate` |
| `booking_technician_id` | Same moment | `data.recommended_slot.TechnicianID` or chosen slot’s `TechnicianID` |
| `booking_slot_display` | Optional (for prompts) | `data.recommended_slot.display` |

**Tool response assignments (ElevenLabs “Assign response to variables”)**

On node **`booking_availability`**, after successful tool:

| Variable | JSON path |
|----------|-----------|
| `booking_store` | `data.store` |
| `booking_service_date` | `data.recommended_slot.ServiceDate` |
| `booking_technician_id` | `data.recommended_slot.TechnicianID` |
| `booking_slot_display` | `data.recommended_slot.display` |

If the customer picks a **backup** slot, overwrite `booking_service_date` / `booking_technician_id` from that backup object in the same response (`data.backup_slots[0]` or `[1]`).

You do **not** need `booking_session_id` for the two-tool flow.

---

## Tool 1 — availability (`hubtiger_booking_availability_readonly`)

### When to call

- New booking intent, after store is known (or ask: “What store would you like to book the bike in?”).
- **Not** for existing job status (use `hubtiger_job_search` / `hubtiger_job_get`).

### Request mapping (LLM → body)

| Field | Required | Values / notes |
|-------|----------|----------------|
| `function` | Yes (constant) | `booking_availability` |
| `store` | Yes | `southport` \| `brisbane` \| `burleigh` (Newstead → `brisbane`) |
| `start_date` | Optional | `YYYY-MM-DD`; default today if omitted |
| `end_date` | Optional | Range end |
| `cache_mode` | Optional | `no_cache` only if caller says times feel stale |
| `payload.deadline_date` | For “by [date]” | e.g. birthday `2026-06-02` |
| `payload.scheduling_goal` | With deadline | `before_deadline` or `earliest` |
| `payload.customer_request` | Optional | Short paraphrase of caller words |
| `payload.service_notes` | Optional | Flat tyre, brakes, etc. |
| `payload.preferred_time` | Optional | morning / afternoon / 10am |

### Response mapping (tool → voice)

| Field | Use on call |
|-------|-------------|
| `message` | Primary line to read |
| `data.slot_count` | 0 → no invented times; callback / other store |
| `data.recommended_slot.display` | Offer first: “I have … at [display], does that suit?” |
| `data.backup_slots[]` | Up to two alternates (max **three** offers total) |
| `data.recommended_slot.ServiceDate` | Save to `booking_service_date` |
| `data.recommended_slot.TechnicianID` | Save to `booking_technician_id` |

### Edge out

- Customer accepts a slot → `booking_collect`
- No slots → stay in conversation; retry other store/date or offer callback (no create tool)

---

## Tool 2 — create (`hubtiger_booking_create`)

### When to call

- **Only after** availability succeeded and customer confirmed a slot.
- **Only after** you have: first name, last name, mobile, vehicle model, issue description, service type.

### Request mapping (LLM → body)

| Field | Required | Source |
|-------|----------|--------|
| `function` | Yes (constant) | `booking_create` |
| `store` | Yes | `{{booking_store}}` or same store as availability |
| `payload.first_name` | Yes | Conversation |
| `payload.last_name` | Yes | Conversation |
| `payload.mobile` | Yes | AU mobile; normalise to +61 in backend |
| `payload.vehicle_model` | Yes | e.g. `Fatfish OG` |
| `payload.issue_description` | Yes | What they want done |
| `payload.service_type` | Yes | `service_full` \| `service_plus` \| use `service_plus` + callback flag for non-standard |
| `payload.needs_workshop_callback` | Optional | `true` for tyre / controller / unclear repair |
| `payload.ServiceDate` | Yes | `{{booking_service_date}}` from chosen slot |
| `payload.TechnicianID` | Yes | `{{booking_technician_id}}` |
| `payload.email` | Optional | If given |

**Service type guidance (prompt + tool description)**

| Customer need | `service_type` | `needs_workshop_callback` |
|---------------|----------------|---------------------------|
| Standard service / first service | `service_full` or `service_plus` | `false` |
| Tyres, error codes, major repair, quote-only | `service_plus` (or non-standard path) | `true` — still book; mechanic calls back |

### Response mapping (tool → voice)

| Field | Customer line |
|-------|----------------|
| `data.booking_confirmed` = true | “I've booked that in. You'll receive SMS updates from the Ride Electric service software shortly.” |
| `customer_outcome` = `pending_staff_review` or `booking_confirmed` false | “I've sent that to our workshop team to confirm. You'll get SMS once it's locked in.” |
| `data.pending_workshop_callback` | Explain mechanic will call about work and costs (booking still logged) |

Never say “you’re booked in” unless `booking_confirmed` is true.

### Edge out

- → `booking_complete` (closing, no more tools)

---

## Prompt changes (what to paste where)

### Global agent (optional, short)

Use `backend/src/ghostdash_api/magic_mike.py` → `MAGIC_MIKE_SYSTEM_PROMPT` block (already aligned to **availability + create**).  
Do **not** paste the long staged prompt from `docs/MAGIC_MIKE_HUBTIGER_AGENT_SYSTEM_PROMPT.md` on every workflow node.

### Per-node (recommended)

| Node | Prompt file |
|------|-------------|
| `booking_availability` | `workflow-prompts/NODE_SIMPLE_01_availability.md` |
| `booking_collect` | `workflow-prompts/NODE_SIMPLE_02_collect.md` |
| `booking_create` | `workflow-prompts/NODE_SIMPLE_03_create.md` |
| `booking_complete` | `workflow-prompts/NODE_done.md` |

### GhostDASH simulator

- **Chat** tab: full Magic Mike (may call tools via agent profile).
- **Booking** tab: staged steps only — for **two-tool** testing use Tools page or ElevenLabs with the JSONs above.

---

## Production / env checklist

| Setting | Why |
|---------|-----|
| `HUBTIGER_TOOL_ACCESS=read_write` | Required for `booking_create` |
| `HUBTIGER_BOOKING_AUTO_EXECUTE=true` | Voice books without staff queue (optional) |
| `HUBTIGER_PROXY_URL` + MCP healthy | Tools reach portal |
| Rebuild `hubtiger-mcp` after availability ranking changes | `recommended_slot` includes `ServiceDate` / `TechnicianID` |

---

## Quick test matrix

| Step | Action | Pass |
|------|--------|------|
| 1 | Availability `store=brisbane`, `scheduling_goal=earliest` | `slot_count` > 0, `recommended_slot` has `ServiceDate` + `TechnicianID` |
| 2 | Customer accepts recommended | Variables set |
| 3 | Create with all payload fields | `booking_confirmed` true or clear staff-review message |
| 4 | Sunday / 7am request | Refused in prompt; no create outside hours |

---

## Related docs

- Availability detail: `docs/HUBTIGER_BOOKING_AVAILABILITY_ELEVENLABS_LLM_GUIDE.md`
- Staged 8-tool flow: `docs/HUBTIGER_BOOKING_WORKFLOW_NODES.md`
- Import checklist: `docs/HUBTIGER_ELEVENLABS_WORKFLOW_SETUP_CHECKLIST.md`
