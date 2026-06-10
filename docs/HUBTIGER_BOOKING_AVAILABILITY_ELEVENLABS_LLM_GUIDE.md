# HubTiger Booking Availability — ElevenLabs LLM Guide (Live)

**Purpose:** Copy-ready prompts and response rules for Magic Mike (and other Ride Electric voice agents) using the `hubtiger_booking_availability_readonly` webhook tool.

**Status:** Ready for production on `ghoststack.rideai.com.au` (verified: health `ok`, live availability returns ranked slots).

---

## Go-live checklist (do once)

| Step | Action |
|------|--------|
| 1 | Import tool JSON: `scripts/hubtiger/hubtiger_booking_availability.json` (mirror: `scripts/hubtiger/hubtiger-api/elevenlabs-tools/hubtiger_booking_availability.json`) |
| 2 | In ElevenLabs tool settings, set header **`X-Ghost-Voice-Key`** to the same value as GhostDASH **`ELEVENLABS_HUBTIGER_WEBHOOK_SECRET`** or **`APP_VOICE_INGRESS_SECRET`** (do not commit the key in git) |
| 3 | Confirm URL is **`https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`** (POST) |
| 4 | Attach this guide (or the **Agent system prompt** section below) to the agent’s system instructions |
| 5 | Smoke test: ask *“When can I book my bike in at Brisbane this week?”* — agent should call the tool and speak **real dates/times** from the response |

**Health check (optional):** `GET https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/health` with the same voice key → `"ready": true`.

---

## What this tool does

- **Read-only** workshop availability (does **not** create a booking).
- Searches HubTiger live calendar for **Brisbane, Southport, or Burleigh**.
- Returns **one recommended time** plus **two backup times** closest to it.
- For *“I need it done by [date]”* (birthday, event, deadline), picks the **best slot on or before that date**, then two alternatives near that time.

To **confirm** a booking after the customer chooses a time, use the separate **`hubtiger_booking_create`** tool (if enabled on the agent).

---

## When to call the tool

| Customer says (examples) | Call tool? |
|--------------------------|------------|
| “When can I book in?” / “Any availability this week?” | **Yes** |
| “I need it serviced before my birthday on 2 June” | **Yes** (deadline flow) |
| “What’s the earliest you can see me in Brisbane?” | **Yes** (`scheduling_goal: earliest`) |
| “Book me in for Tuesday” (no prior availability check) | **Yes** first, then booking tool if they confirm |
| “Where is my job up to?” / job status | **No** — use job lookup tools |
| “How much for brake pads?” | **No** — use quote tools |

**Before calling:** confirm **store** (southport, brisbane, burleigh). If unclear, ask one short question: *“Which store — Brisbane, Southport, or Burleigh?”*

---

## How to build the request

Always send `function: booking_availability` (fixed in tool JSON).

### Stores (required)

| Customer wording | `store` value |
|------------------|---------------|
| Brisbane, Newstead, city | `brisbane` |
| Southport, Gold Coast north | `southport` |
| Burleigh, Burleigh Heads | `burleigh` |

### Patterns

**A — Soonest / this week**

```json
{
  "function": "booking_availability",
  "store": "brisbane",
  "start_date": "2026-05-20",
  "payload": {
    "scheduling_goal": "earliest"
  }
}
```

Omit `start_date` to search from **today**.

**B — Must be done BY a date (birthday, event, “before 2 June”)**

```json
{
  "function": "booking_availability",
  "store": "brisbane",
  "payload": {
    "deadline_date": "2026-06-02",
    "scheduling_goal": "before_deadline",
    "customer_request": "Needs service before birthday on 2 June"
  }
}
```

Do **not** guess the year — use the current or next sensible year from context (today’s date in the session).

**C — Stale calendar (“I just booked online but you say nothing”)**

Repeat the same body with `"cache_mode": "no_cache"`.

---

## How to read the response

Top-level fields (use these only — never read internal/trace fields):

| Field | Use |
|-------|-----|
| `success` | `true` = call worked (even if no slots) |
| `message` | **Primary script** — safe to paraphrase for the caller |
| `operation` | Should be `availability_lookup` |
| `data.slot_count` | Number of open slots found |
| `data.recommended_slot` | Best fit: `display`, `date`, `time` |
| `data.backup_slots` | Up to two alternates (array) |
| `data.first_slots` | Same three times as strings (`YYYY-MM-DD HH:MM`) |
| `data.booking_offers` | Ranked list: `recommended`, `backup_1`, `backup_2` |

If `success` is `false`, do **not** invent times. Use `message` or offer callback / another store.

---

## How to present data (voice)

### Rules

1. **Short and spoken** — one breath per option; no JSON, no “slot_count”, no technician IDs.
2. **Offer three times max** — recommended first, then backups only if useful.
3. **Confirm store** once: *“That’s for our Brisbane workshop.”*
4. **Never claim a booking is made** — this tool only checks availability. Say *“I can hold that time once we confirm details”* or use the booking tool next.
5. If `slot_count` is **0**, say you couldn’t see openings in that window and offer: another date, another store, or a team callback.

### Templates

**Slots found (deadline / “by” date):**

> “For Brisbane, the best option to have you done before [deadline in words] is **[recommended day and time]**. I can also do **[backup 1]** or **[backup 2]**. Which works best?”

**Slots found (earliest / general):**

> “I’ve got **[recommended]** at Brisbane. I can also do **[backup 1]** or **[backup 2]**. Would any of those suit?”

**No slots:**

> “I’m not seeing open workshop times for [store] between [window]. I can check Southport or Burleigh, try different dates, or have the team call you back. What would you prefer?”

### Format times for voice

| API `display` | Say |
|---------------|-----|
| `2026-05-20 12:15` | “Wednesday the 20th of May at quarter past twelve” |
| `2026-06-01 09:00` | “Sunday the 1st of June at nine am” |

Prefer **day + date + month + time**; avoid ISO strings and 24-hour clock unless the caller prefers it.

---

## Agent system prompt (paste into ElevenLabs)

**Full workflow prompt (booking + job visibility + operating hours):**  
[`docs/MAGIC_MIKE_HUBTIGER_AGENT_SYSTEM_PROMPT.md`](./MAGIC_MIKE_HUBTIGER_AGENT_SYSTEM_PROMPT.md)

**Availability-only excerpt:**

```text
You are Magic Mike, Ride Electric's service assistant.

WORKSHOP HOURS (NEVER BREAK THIS)
Monday–Saturday only, 8:30am–5:00pm Brisbane time.
Never offer or accept bookings on Sunday, before 8:30am, or at/after 5:00pm.

TOOL hubtiger_booking_availability_readonly
- Read-only live calendar — does NOT create a booking.
- Required store: brisbane | southport | burleigh.
- deadline_date + scheduling_goal=before_deadline for "by [date]" requests.
- scheduling_goal=earliest for soonest slot.
- Speak from message, recommended_slot, and up to two backup_slots (max three times, in-hours only).
- If slot_count is 0, do not invent times.

After they choose a time, use booking_create only if enabled; otherwise team follow-up.
Never say "booked in" unless booking_confirmed is true.

Short voice. No APIs, JSON, or internal errors to the customer.
```

---

## Example dialogues

### 1 — Birthday deadline

**Customer:** “Second of June is my birthday — I need the bike serviced by then. What’s available between now and then?”

**Tool request:**

```json
{
  "function": "booking_availability",
  "store": "brisbane",
  "payload": {
    "deadline_date": "2026-06-02",
    "scheduling_goal": "before_deadline",
    "customer_request": "Serviced before birthday 2 June"
  }
}
```

**Example tool `message`:**

> “The best option to have your bike serviced before 2 June is 1 June at 9:00. I can also offer 30 May at 9:00 or 30 May at 9:00.”

**You say:**

> “For Brisbane, the best I can do before your birthday on the second of June is **Sunday the first at nine in the morning**. I’ve also got **Friday the thirtieth of May at nine**, or we can look at another store if you’d like. Which suits you?”

### 2 — This week

**Customer:** “Earliest booking at Southport?”

**Tool request:**

```json
{
  "function": "booking_availability",
  "store": "southport",
  "payload": { "scheduling_goal": "earliest" }
}
```

**You say (if slots returned):**

> “At Southport, the soonest I can see is **[recommended]**. I also have **[backup 1]** and **[backup 2]**. Want me to note one of those?”

### 3 — No availability

**Customer:** “Anything tomorrow in Burleigh?”

**Tool returns:** `slot_count: 0`, message explains no openings.

**You say:**

> “I’m not seeing open times tomorrow at Burleigh. I can check the rest of the week, try Brisbane or Southport, or have someone from the team call you back. What works best?”

---

## What NOT to do

| Do not | Why |
|--------|-----|
| Invent times when `slot_count` is 0 | Breaks trust; calendar may truly be full |
| Say “you’re booked in” after this tool | Read-only — use booking tool or staff |
| Read `message` verbatim if it contains jargon | Paraphrase into natural speech |
| Expose errors, stack traces, or “HubTiger failed” | Use retail-safe fallback from `message` |
| Ask for ten fields before calling | Only store + date intent required |
| Use `ghost.rideai.com.au` or old tool URLs | Canonical host: **ghoststack.rideai.com.au** |

---

## Troubleshooting (agent behaviour)

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Tool 401 | Wrong `X-Ghost-Voice-Key` in ElevenLabs | Match GhostDASH env secret |
| Always zero slots | Wrong store slug or stale agent cache | Fix store; retry with `cache_mode: no_cache` |
| Generic “call completed” with no times | Old control-api build | Ops: rebuild `control-api` + `hubtiger-mcp` |
| Times don’t match portal | Different week/store than customer asked | Re-run with correct `deadline_date` / range |

---

## Related files

| File | Role |
|------|------|
| `scripts/hubtiger/hubtiger_booking_availability.json` | ElevenLabs import (availability) |
| `scripts/hubtiger/hubtiger_job_search.json` | ElevenLabs import (job status step 1) |
| `scripts/hubtiger/hubtiger_job_get.json` | ElevenLabs import (job status step 2, `job_retrieve`) |
| `scripts/hubtiger/hubtiger_booking_create.json` | ElevenLabs import (book confirmed slot) |
| `docs/HUBTIGER_BOOKING_CREATE_ELEVENLABS_LLM_GUIDE.md` | Booking workflow + service types |
| `docs/hubtiger_booking_availability_handover.md` | Engineering handover + curl tests |
| `docs/HUBTIGER_OPERATOR_PLAYBOOK.md` | All HubTiger functions |

---

## Booking submit (`hubtiger_booking_create`) — gated

**Do not enable on the live agent until backend sign-off.** When enabled:

- Tool URL: `POST https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/booking_create`
- Import JSON: `scripts/hubtiger/hubtiger-api/elevenlabs-tools-download/hubtiger_booking_create.json`
- Set `X-Ghost-Voice-Key` from GhostDASH env (same as availability tool).

**After the tool returns**

| Tool field | Voice behaviour |
|------------|-----------------|
| `booking_confirmed: true` | Say: *"I've booked that in. You'll receive SMS updates from the Ride Electric service software shortly."* |
| `customer_outcome: pending_staff_review` or `booking_confirmed: false` | Say: *"I've sent that to our workshop team to confirm. You'll get SMS once it's locked in."* |
| `success: false` | Do not claim booked; offer another slot or callback. |

Never say the customer is booked unless `booking_confirmed` is true.

---

## Live verification snapshot (2026-05-20)

- `GET /api/elevenlabs/hubtiger/health` → `ready: true`
- Brisbane week 18–24 May → **6 slots**, recommended e.g. **20 May 12:15**
- Birthday by 2 Jun → **14 slots**, recommended **1 Jun 09:00** + backups

This guide matches the deployed behaviour above.
