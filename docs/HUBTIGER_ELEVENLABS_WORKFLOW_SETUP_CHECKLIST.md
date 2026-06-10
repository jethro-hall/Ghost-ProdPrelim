# HubTiger + Magic Mike — ElevenLabs Workflow Setup Checklist

Use this when wiring the **Ride Electric booking workflow** in ElevenLabs and when validating from **GhostDASH**.

## Choose your booking path

| Path | Tools | Doc |
|------|-------|-----|
| **Two-tool (tested, recommended)** | `hubtiger_booking_availability.json` + `hubtiger_booking_create.json` | [`HUBTIGER_BOOKING_TWO_TOOL_ELEVENLABS_MAP.md`](./HUBTIGER_BOOKING_TWO_TOOL_ELEVENLABS_MAP.md) |
| **Staged (8 tools, long calls)** | slot → customer → bike → service → submit | [`HUBTIGER_BOOKING_WORKFLOW_NODES.md`](./HUBTIGER_BOOKING_WORKFLOW_NODES.md) |

Related docs:

- **Two-tool map:** [`HUBTIGER_BOOKING_TWO_TOOL_ELEVENLABS_MAP.md`](./HUBTIGER_BOOKING_TWO_TOOL_ELEVENLABS_MAP.md)
- Staged node map: [`HUBTIGER_BOOKING_WORKFLOW_NODES.md`](./HUBTIGER_BOOKING_WORKFLOW_NODES.md)
- Per-node prompts: `scripts/hubtiger/workflow-prompts/`
- Dashboard simulator: **Header → Agent test** (slide-out panel, right side)

---

## A. ElevenLabs — import tools (once per agent)

Import each JSON from `scripts/hubtiger/` (copies under `hubtiger-api/elevenlabs-tools/`):

- [ ] `hubtiger_booking_availability.json` (readonly availability)
- [ ] `hubtiger_booking_slot.json`
- [ ] `hubtiger_booking_customer_search.json`
- [ ] `hubtiger_booking_customer_confirm.json`
- [ ] `hubtiger_booking_bike_list.json`
- [ ] `hubtiger_booking_bike_confirm.json`
- [ ] `hubtiger_booking_service_set.json`
- [ ] `hubtiger_booking_submit.json`

Set on **every** tool:

- [ ] URL: `https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`
- [ ] Header: `X-Ghost-Voice-Key` = GhostDASH env (`ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` or `APP_VOICE_INGRESS_SECRET`)
- [ ] Timeouts: 15–25s for read steps; 45s for `hubtiger_booking_submit`

---

## B. ElevenLabs — workflow variable

- [ ] Create dynamic variable: **`booking_session_id`** (string)
- [ ] After **slot** tool success: set from `data.booking_session_id`
- [ ] Pass in every later tool body: `payload.booking_session_id` = `{{booking_session_id}}`

---

## C. ElevenLabs — one node per row

| Done | Workflow node ID | Node type | Tool(s) attached | Prompt file |
|------|------------------|-----------|------------------|-------------|
| [ ] | `booking_availability` | Tool | `hubtiger_booking_availability_readonly` only | `NODE_00_availability.md` |
| [ ] | `booking_slot` | Tool | `hubtiger_booking_slot` only | `NODE_01a_slot.md` |
| [ ] | `booking_customer_collect` | **Subagent / conversation** | **None** | `NODE_01b_collect_customer.md` |
| [ ] | `booking_customer_search` | Tool | `hubtiger_booking_customer_search` only | `NODE_01b_customer_search.md` |
| [ ] | `booking_customer_confirm` | Tool | `hubtiger_booking_customer_confirm` only | `NODE_01b_customer_confirm.md` |
| [ ] | `booking_bike_list` | Tool | `hubtiger_booking_bike_list` only | `NODE_02a_bike_list.md` |
| [ ] | `booking_bike_confirm` | Tool | `hubtiger_booking_bike_confirm` only | `NODE_02b_bike_confirm.md` |
| [ ] | `booking_service` | Tool | `hubtiger_booking_service_set` only | `NODE_03a_service.md` |
| [ ] | `booking_submit` | Tool | `hubtiger_booking_submit` only | `NODE_03b_submit.md` |
| [ ] | `booking_complete` | **Conversation** | **None** | `NODE_done.md` |

Rules for every node:

- [ ] Paste **only** that node’s prompt (not the full Magic Mike mega-prompt)
- [ ] **One tool maximum** per tool node
- [ ] After each tool: speak **`voice_line`** / `message` only — never raw JSON
- [ ] Frustrated caller: one acknowledgement, one question, then tool

---

## D. ElevenLabs — edges (suggested)

- [ ] `booking_availability` → customer picked time → `booking_slot`
- [ ] `booking_slot` → `workflow_node` = `booking_customer_search` → `booking_customer_collect` OR collect first then search
- [ ] `booking_customer_collect` → have name + mobile → `booking_customer_search`
- [ ] `booking_customer_search` → always → `booking_customer_confirm`
- [ ] `booking_customer_confirm` → `customer_confirmed` true → `booking_bike_list`
- [ ] `booking_bike_list` → → `booking_bike_confirm`
- [ ] `booking_bike_confirm` → `bike_confirmed` true → `booking_service`
- [ ] `booking_service` → `service_confirmed` true → `booking_submit`
- [ ] `booking_submit` → `booking_confirmed` or pending message → `booking_complete`

---

## E. GhostDASH — operator simulation panel

- [ ] Open any dashboard page → **Agent test** (header) or event `ghostdash:open-simulation`
- [ ] **Inline** tab: chat + Magic Mike opening line
- [ ] **Mock tools On**: run **Booking workflow** tab step-by-step (mirrors API)
- [ ] **Widget** tab: voice visual preview (production voice = ElevenLabs embed)
- [ ] Expand control widens panel for long `booking_session_id` / payloads

---

## F. Production gates

- [ ] `HUBTIGER_TOOL_ACCESS=read_write` for confirm + submit steps
- [ ] `HUBTIGER_BOOKING_AUTO_EXECUTE=true` if voice should book without staff queue
- [ ] Rebuild: `hubtiger-proxy`, `hubtiger-mcp`, `control-api`, `ui` after deploy
- [ ] Workshop hours enforced: Mon–Sat **8:30am–5:00pm** Brisbane

---

## G. Smoke test script (dashboard workflow tab)

1. [ ] Run **availability** → note slots  
2. [ ] Run **slot** → copy `booking_session_id`  
3. [ ] Run **customer_search** → read candidates  
4. [ ] Run **customer_confirm** → `customer_confirmed`  
5. [ ] Run **bike_list** → read bikes  
6. [ ] Run **bike_confirm** → `bike_confirmed`  
7. [ ] Run **service** → fast, `service_confirmed`  
8. [ ] Run **submit** → `booking_confirmed` or staff-review message  

---

## H. Do not use on voice workflow

- [ ] Avoid `hubtiger_booking_create` single-shot on voice (use staged tools)
- [ ] Do not attach multiple HubTiger tools to one node
- [ ] Do not skip **customer_confirm** or **bike_confirm**
