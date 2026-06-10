# HubTiger Staged Booking — ElevenLabs LLM Guide

**For ElevenLabs Workflows (isolated nodes):** use [`HUBTIGER_BOOKING_WORKFLOW_NODES.md`](./HUBTIGER_BOOKING_WORKFLOW_NODES.md) and per-node prompts in `scripts/hubtiger/workflow-prompts/`.

**Purpose:** The API holds booking state server-side. Each workflow node calls **one tool** and speaks **`voice_line`** from the response.

**Endpoint:** `POST https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`  
**Auth:** `X-Ghost-Voice-Key`

---

## Workflow nodes (10 + done)

| Step | Node | Tool |
|------|------|------|
| 0 | Availability | `hubtiger_booking_availability_readonly` |
| 1a | Slot | `hubtiger_booking_slot` |
| 1b | Collect name/phone | *(conversation only)* |
| 1b | Customer search | `hubtiger_booking_customer_search` |
| 1b | Customer confirm | `hubtiger_booking_customer_confirm` |
| 2a | Bike list | `hubtiger_booking_bike_list` |
| 2b | Bike confirm | `hubtiger_booking_bike_confirm` |
| 3a | Service + issue | `hubtiger_booking_service_set` |
| 3b | Submit booking | `hubtiger_booking_submit` |
| Done | Close | *(conversation only)* |

Pass **`booking_session_id`** on every step after slot (ElevenLabs dynamic variable).

---

## Step 3 split

- **3a `booking_service_set`** — fast; saves service type and issue on session.
- **3b `booking_submit`** — HubTiger write; may return `pending_staff_review`.

Legacy **`hubtiger_booking_finalize`** combines 3a+3b in one tool (avoid in voice workflows).

---

## Workshop hours

Monday–Saturday **8:30am–5:00pm** Brisbane.
