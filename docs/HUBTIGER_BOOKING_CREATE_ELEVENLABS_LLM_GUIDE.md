# HubTiger Booking Create — ElevenLabs LLM Guide

**Purpose:** Book a confirmed workshop slot after `hubtiger_booking_availability_readonly` returns times the customer accepts.

**Import JSON (recommended — staged):** see [`HUBTIGER_BOOKING_STAGED_ELEVENLABS_LLM_GUIDE.md`](./HUBTIGER_BOOKING_STAGED_ELEVENLABS_LLM_GUIDE.md)  
**Legacy single-shot:** `scripts/hubtiger/hubtiger_booking_create.json`  
**API:** `POST https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`  
**Auth:** `X-Ghost-Voice-Key` = `ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` or `APP_VOICE_INGRESS_SECRET`

Master system prompt: [`MAGIC_MIKE_HUBTIGER_AGENT_SYSTEM_PROMPT.md`](./MAGIC_MIKE_HUBTIGER_AGENT_SYSTEM_PROMPT.md)

---

## Staged booking (preferred for voice)

The API keeps a `booking_session_id` and runs HubTiger customer/bike/schedule calls per step. Import six tools: slot → customer search → customer confirm → bike list → bike confirm → finalize.

---

## Workflow (strict order — legacy single-shot)

1. Confirm **store** (brisbane | southport | burleigh).
2. Call **`hubtiger_booking_availability_readonly`** → offer ≤3 in-hours times (Mon–Sat **8:30am–5:00pm**).
3. Customer picks a time → collect mandatory details (one question at a time if needed):
   - First name
   - Last name
   - Mobile
   - Bike/scooter model (e.g. `Fatfish OG`)
   - What they want done / what is wrong (brief)
4. Ask what service they want:
   - Offer **`Service Full`** (`service_type: service_full`)
   - Offer **`Service Plus`** (`service_type: service_plus`)
5. Call **`hubtiger_booking_create`** with slot + customer fields.

---

## Non-standard work (tyres, controller errors, unclear repair)

- Still **create the booking** (use `needs_workshop_callback: true` or `service_type` mentioning tyre/error/repair).
- Tell the customer: *"I've logged that in. A mechanic from the workshop will call you back shortly to talk through the work and any costs."*
- Do **not** quote prices unless from an approved quote tool.

---

## Example tool request

```json
{
  "function": "booking_create",
  "store": "brisbane",
  "payload": {
    "first_name": "Jeff",
    "last_name": "Hall",
    "mobile": "+61435185134",
    "vehicle_model": "Fatfish OG",
    "issue_description": "Squeaky brakes and full safety check",
    "service_type": "service_full",
    "ServiceDate": "2026-05-23T13:40",
    "TechnicianID": 2730,
    "email": "research@rideelectric.com.au"
  }
}
```

Use `ServiceDate` and `TechnicianID` from the **chosen availability slot** (`recommended_slot` or backup).

---

## Voice outcomes

| Tool result | Say |
|-------------|-----|
| `booking_confirmed: true` | "I've booked that in. You'll receive SMS updates from Ride Electric shortly." |
| `customer_outcome: pending_workshop_callback` | "I've logged your booking. A mechanic will call you back shortly to discuss the work and costs." |
| `customer_outcome: pending_staff_review` | "I've sent that to our workshop team to confirm. You'll get SMS once it's locked in." |
| `success: false` | Safe fallback — offer callback or human handoff; never expose errors |

---

## Production gates

| Setting | Effect |
|---------|--------|
| `HUBTIGER_TOOL_ACCESS=read_write` | Allows write tools |
| `HUBTIGER_BOOKING_AUTO_EXECUTE=true` | Auto-runs ScheduleService after preflight (otherwise staff review queue) |
| Portal auth in `.env` | `HUBTIGER_USERNAME` / `HUBTIGER_PASSWORD` (same as availability) |

HAR reference: `jobcreatejobbookinghubtigerportal.azurewebsites.net.har` → `ScheduleService`, `Bike`, cyclist search.

---

## Service type IDs (Brisbane partner 2186)

| Key | HubTiger ID | Label |
|-----|-------------|--------|
| `service_full` | 19798 | Service Full |
| `service_plus` | 19799 | Service Plus |
| non-standard fallback | 79575 | Quotation (workshop callback) |

Config: `scripts/hubtiger/hubtiger-proxy/config/booking_service_types.json`
