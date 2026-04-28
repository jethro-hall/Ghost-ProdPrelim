# HubTiger Tool Activation Policy For Magic Mike

## Purpose

HubTiger tools must not be called for every conversation.

They are only used when the customer intent requires Ride Electric service/workshop/customer/bike/job data.

This keeps the call fast, reduces LLM drift, reduces unnecessary API calls, and keeps Magic Mike sounding like a human service assistant instead of a backend search bot.

## Core rule

Do not activate HubTiger tools unless the customer clearly triggers a service/workshop/customer-bike/job intent.

Magic Mike should handle general greetings, casual chat, product questions, warranty process questions, and general Ride Electric questions without calling HubTiger unless the customer specifically connects the request to their own bike/scooter, workshop job, booking, drop-off, pickup, or return call.

## Valid HubTiger activation triggers

Use HubTiger only when the customer:

```text
1. Asks about their e-bike or scooter.
2. Says they own a bike/scooter and need help with it.
3. Says their bike/scooter is in the workshop.
4. Asks about pickup time, drop-off time, repair status, job status, service status, or quote status.
5. Says they are returning a call from Ride Electric.
6. Says a mechanic, workshop, or reception called them.
7. Wants to book a service or repair for their bike/scooter.
8. Wants to add information to an existing workshop job.
9. Wants to check a quote connected to their bike/scooter or job.
```

## Non-trigger examples

Do not call HubTiger for:

```text
Hi / hello / how are you
What do you do?
Tell me about Fatfish / VSETT / Smartmotion generally
What is the warranty process?
How does first service work generally?
Do you sell helmets?
What are your stores?
What are your opening hours?
General legal or road-rule questions
General product information not tied to the customer record
```

For those, answer directly or use approved product/legal/warranty retrieval if needed.

## Return-call rule

If the customer says they are returning a call, use HubTiger.

Reason:

```text
A mechanic or reception team member should have left a note, job update, call-back reason, or customer/job record.
```

Flow:

```text
1. Ask for mobile number first.
2. Call customer/bike/job search.
3. Look for recent jobs, notes, messages, call-back notes, or active workshop records.
4. If a clear record is found, summarize the customer-safe reason.
5. If unclear, collect name/mobile/reason and offer handoff.
```

Suggested line:

```text
No worries, can I grab your mobile number so I can check what the team called about?
```

## Primary lookup tool

The first lookup tool for service/workshop/customer-bike intent should be a composite read-only function:

```text
hubtiger_customer_context_lookup
```

This should talk to GhostDash, not HubTiger directly.

Endpoint:

```text
POST /api/elevenlabs/hubtiger/customer_context_lookup
```

It should quickly return the data Magic Mike needs in one call:

```text
customer match
active bikes/scooters
active jobs
recent notes
call-back notes
open quotes
upcoming bookings
last service context
```

This is preferred over multiple low-level calls because it is faster and reduces LLM drift.

## Input schema

```json
{
  "mobile": "optional customer mobile number",
  "first_name": "optional first name",
  "last_name": "optional last name",
  "search": "optional general search phrase",
  "intent": "service_booking|workshop_status|pickup|dropoff|returning_call|quote|customer_bike|unknown",
  "limit": 5
}
```

## Public-safe response shape

```json
{
  "success": true,
  "public_message": "I found the matching Ride Electric record.",
  "data": {
    "customers": [],
    "bikes": [],
    "active_jobs": [],
    "recent_notes": [],
    "callback_items": [],
    "open_quotes": [],
    "upcoming_bookings": []
  },
  "error_code": null,
  "retryable": false
}
```

Never return raw HubTiger payloads to ElevenLabs.

## Fast workflow design

Use preset backend functions that return concise, customer-safe answers or structured summaries.

Preferred design:

```text
ElevenLabs/Mike intent gate
→ one GhostDash composite tool call
→ GhostDash preset HubTiger function
→ public-safe result
→ Mike speaks one short answer
```

Avoid:

```text
LLM deciding many HubTiger subcalls
LLM stitching raw HubTiger data
multiple low-level calls for normal status checks
raw tool result exposed to customer
```

## Tool activation decision table

| Customer says | Use HubTiger? | First action |
|---|---:|---|
| Hi, how are you? | No | Natural greeting |
| What is the warranty process? | No | Warranty process guard answer |
| Tell me about the Fatfish OG | No | Product answer/retrieval |
| My scooter is in the workshop | Yes | Ask mobile, lookup context |
| When can I pick up my bike? | Yes | Ask mobile, lookup active job |
| I’m returning a call | Yes | Ask mobile, lookup call-back/job notes |
| I need to book a service | Yes | Ask mobile, lookup bike/customer, then store/availability |
| Can you add this to my job? | Yes | Ask mobile/job identifier, lookup job, then note tool |
| What’s the price of a tyre? | Maybe | Product/quote tool only if pricing is requested |

## Magic Mike system prompt insert

Use this in the ElevenLabs/Magic Mike system prompt:

```text
# HUBTIGER TOOL ACTIVATION RULE
Do not call HubTiger tools for greetings, casual chat, general product questions, general warranty process questions, or general Ride Electric questions.

Only use HubTiger when the customer directly asks about their own e-bike/scooter, says their bike/scooter is in the workshop, asks about pickup, drop-off, repair status, job status, quote status, wants to book a service/repair, wants to add to an existing job, or says they are returning a call from Ride Electric, a mechanic, the workshop, or reception.

If the customer is returning a call, assume there may be a recent job note or call-back reason. Ask for their mobile number and use the customer context lookup.

Use the fastest available GhostDash composite HubTiger lookup first. Do not make multiple low-level HubTiger calls unless the first lookup result requires it.

Never mention HubTiger, tools, backend, API, or lookup mechanics to the customer. Speak as Ride Electric.
```

## Booking workflow with activation gate

```text
If customer wants service/repair booking:
1. Ask for mobile number to find their bike.
2. Call customer_context_lookup.
3. If customer/bike found, confirm only if needed: “Is this for your [model]?”
4. If not found, collect first name, last name, mobile, exact bike/scooter model.
5. Ask: “What store would you like to book the bike in?”
6. Call booking_availability with internal default date window.
7. Offer one slot.
8. Create booking only after accepted and only if write mode enabled.
```

## Latency goal

The lookup path should be one composite API call wherever possible.

Target:

```text
customer_context_lookup response: under 800ms from GhostDash if HubTiger responds normally
status answer after transcript final: under 1600ms perceived latency
```

## Acceptance tests

```text
1. Greeting does not call HubTiger.
2. General warranty process does not call HubTiger.
3. General product question does not call HubTiger unless tied to quote/price/customer job.
4. “My scooter is in the workshop” asks for mobile and calls customer_context_lookup.
5. “When can I pick up my bike?” asks for mobile and calls customer_context_lookup.
6. “I’m returning a call” asks for mobile and calls customer_context_lookup.
7. New service booking uses customer_context_lookup before availability.
8. Availability is not called until store is known.
9. Date ranges are generated internally unless customer asks for a specific date.
10. No raw HubTiger/API/tool wording is spoken.
```
