# HubTiger customer lookup by phone (fast endpoint)

Use this for **fast caller-ID enrichment** from a mobile number: customer name plus the **latest active open workshop job** (`model`, `jobcard`, `date_checked_in`, `location`) when HubTiger has one.

Deploy handoff: `docs/CUSTOMER-BY-PHONE-GHOSTSTACK-HANDOFF.md` · one-shot: `bash scripts/deploy-customer-by-phone-live.sh`

For full repair progress, SMS, or mechanic notes, use `POST /api/elevenlabs/hubtiger/tool` with `job_retrieve` instead.

---

## Production URL

| Item | Value |
|------|--------|
| **Method** | `POST` |
| **URL** | `https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/customer-by-phone` |
| **Content-Type** | `application/json` |
| **Auth header** | `X-Ghost-Voice-Key` **or** `Authorization: Bearer <secret>` |

Public traffic path:

```text
Internet → Caddy (ghoststack.rideai.com.au)
        → control-api:8000  (/api/*)
        → hubtiger-mcp:8096  (/execute, operation customer_search)
        → hubtiger-proxy:8095  (GET /customers/search)
        → HubTiger portal API  (Search/Cyclists)
```

---

## Authentication (the key)

GhostDASH accepts **either** of these secrets from the server `.env` (same as other ElevenLabs HubTiger webhooks):

| Environment variable | Purpose |
|---------------------|---------|
| `ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` | Primary secret ElevenLabs tools should send (recommended for Magic Mike / HubTiger webhooks) |
| `APP_VOICE_INGRESS_SECRET` | Shared voice ingress secret; also accepted for HubTiger tool routes |

### Where to read the value (on the GhostDASH server)

```bash
cd /var/llamaindex/ghoststack-rag

# Preferred for ElevenLabs / external webhooks:
grep -E '^ELEVENLABS_HUBTIGER_WEBHOOK_SECRET=' .env

# Alternate (also works):
grep -E '^APP_VOICE_INGRESS_SECRET=' .env
```

Store the value in your shell (do not commit or paste into tickets):

```bash
export GHOST_VOICE_KEY='paste_secret_here'
```

### Header formats (both valid)

```http
X-Ghost-Voice-Key: <secret>
```

```http
Authorization: Bearer <secret>
```

### What you get if auth is wrong

| HTTP | Meaning |
|------|---------|
| **401** | Missing or wrong secret |
| **503** | No voice secret configured in `.env` (`ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` and `APP_VOICE_INGRESS_SECRET` both empty) |

This endpoint does **not** use `x-rideai-webhook-secret` (that is for `workflow.rideai.com.au` Twilio init webhooks).

---

## Request body

Minimal (recommended):

```json
{
  "phone": "0435185134"
}
```

Accepted phone shapes (all normalized to `04xxxxxxxx` in the JSON response; HubTiger search tries `+61…`, `04…`, and digit variants):

| You send | Stored in `phone` | HubTiger search tries |
|----------|-------------------|------------------------|
| `0404858688` | `0404858688` | `+61404858688`, `0404858688`, … |
| `+61404858688` | `0404858688` | same variants |
| `61404858688` | `0404858688` | same variants |
| `404858688` (9 digits) | `0404858688` | same variants |

Job matching uses the **last 9 digits** so `04`, `+61`, and `61` forms still match open workshop jobs.

**Use mobile, not name.** This endpoint only searches HubTiger **cyclists by phone** (`type=phone`, `limit=1`). Name search is slower and belongs on other tools.

---

## Response body

### Customer found

```json
{
  "success": true,
  "found": true,
  "message": "Customer found.",
  "phone": "0435185134",
  "first_name": "Jeff",
  "last_name": "Hall",
  "customer_id": "12345",
  "error_code": null
}
```

### No match

HubTiger returned zero cyclist rows for that search (after normalization). If `job_search` finds jobs for the same number but this endpoint returns `found: false`, check that `hubtiger-proxy` is on the latest build (cyclist results must be read from the `cyclists` array in the portal response).

```json
{
  "success": true,
  "found": false,
  "message": "No customer was found for that phone number.",
  "phone": "0435185134",
  "first_name": null,
  "last_name": null,
  "customer_id": null,
  "error_code": null
}
```

### Timeout (HubTiger slow; not “API down”)

```json
{
  "success": false,
  "found": false,
  "message": "Customer lookup timed out. Please try again.",
  "phone": "0435185134",
  "first_name": null,
  "last_name": null,
  "customer_id": null,
  "error_code": "hubtiger_timeout"
}
```

### Other errors

| `error_code` | Typical cause |
|--------------|----------------|
| `missing_phone` | Empty `phone` in body |
| `hubtiger_mcp_not_configured` | `HUBTIGER_MCP_URL` missing in control-api env |
| `hubtiger_unavailable` | MCP/proxy/upstream HTTP error |
| `hubtiger_lookup_failed` | Unexpected failure in control-api |

---

## Fastest way to get a response

### 1. Use this endpoint instead of `job_search`

| Approach | Typical latency | Payload | Best for |
|----------|---------------|---------|----------|
| **`customer-by-phone`** | ~1–4s (sometimes up to ~10s) | Names only | Caller ID → “Hi Jeff” |
| **`job_search` with name** | Often **6–12s+** | Job cards, case selection | Workshop status |
| **`job_search` with phone** | ~2–5s | Job list | “Where’s my repair?” |

The Jeff Hall voice failure (`HubTiger test is unavailable right now.`) was a **6s read timeout** on heavy `job_search`, while HubTiger was still returning 200 upstream. This endpoint uses a **dedicated 20s** budget (`HUBTIGER_CUSTOMER_LOOKUP_TIMEOUT_MS`). The proxy runs cyclist search and open-job enrichment **in parallel** to stay under that limit.

### 2. Send Australian mobile in `04…` form

Prefer `0435185134` or `+61435185134`. The server normalizes before calling HubTiger.

### 3. Call production edge directly

Use `https://ghoststack.rideai.com.au/...` — not `ghost.rideai.com.au` (different host / tool registry) unless you know that stack is wired the same way.

### 4. Keep the body tiny

Only `phone` is required. No `store`, `payload`, or `function` — less parsing, one upstream call, `limit=1`.

### 5. Tune timeout only if needed

| Variable | Default | Service |
|----------|---------|---------|
| `HUBTIGER_CUSTOMER_LOOKUP_TIMEOUT_MS` | `20000` | control-api → MCP for **this** route only |
| `HUBTIGER_READ_TIMEOUT_MS` | `6000` | Generic `/api/elevenlabs/hubtiger/tool` |

Increase customer lookup timeout if you see `hubtiger_timeout` during peak HubTiger load:

```bash
# In .env
HUBTIGER_CUSTOMER_LOOKUP_TIMEOUT_MS=15000
```

Then restart control-api:

```bash
docker compose up -d --build control-api
```

### 6. ElevenLabs tool settings for speed

- **Response timeout**: ≥ **20s** (tool JSON in repo uses 20s for other tools; this route allows 12s server-side but leave headroom).
- **Do not** chain this with `job_retrieve` on the same turn if you only need the name.
- Attach tool only on the node that needs caller ID / name confirmation.

---

## Copy-paste curl (production)

```bash
export GHOST_VOICE_KEY='YOUR_ELEVENLABS_HUBTIGER_WEBHOOK_SECRET'

curl -sS -w "\nHTTP %{http_code} time=%{time_total}s\n" \
  -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/customer-by-phone" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{"phone": "0435185134"}' | python3 -m json.tool
```

Bearer variant:

```bash
curl -sS -w "\nHTTP %{http_code} time=%{time_total}s\n" \
  -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/customer-by-phone" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GHOST_VOICE_KEY" \
  -d '{"phone": "+61435185134"}' | python3 -m json.tool
```

### On the GhostDASH server (localhost via Caddy)

```bash
export GHOST_VOICE_KEY='YOUR_SECRET_FROM_.env'

curl -sS -w "\nHTTP %{http_code} time=%{time_total}s\n" \
  -X POST "http://127.0.0.1/api/elevenlabs/hubtiger/customer-by-phone" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{"phone": "0435185134"}' | python3 -m json.tool
```

### Health check (HubTiger stack, not customer lookup)

Confirms MCP is reachable with the same key:

```bash
curl -sS "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/health" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" | python3 -m json.tool
```

Expect `"ready": true` when MCP/proxy are healthy.

---

## ElevenLabs tool (import JSON)

**Import file:** `scripts/hubtiger/hubtiger_customer_by_phone.json`  
**Mirrors:** `scripts/hubtiger/hubtiger-api/elevenlabs-tools/hubtiger_customer_by_phone.json`

### Steps in ElevenLabs

1. Open your agent → **Tools** → **Add tool** → **Import from JSON**.
2. Paste the full contents of `hubtiger_customer_by_phone.json`.
3. Edit the tool → **Headers** → set `X-Ghost-Voice-Key` to the value of `ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` from GhostDASH `.env` (replace `SET_IN_ELEVENLABS_FROM_GHOSTDASH_ENV`). Do not commit the live key.
4. Set **Response timeout** to **25 seconds** (matches `response_timeout_secs` in the JSON).
5. Attach the tool to **Magic Mike** (or your voice agent).
6. Save the agent.

### Optional: sync from GhostDASH Voice Ops

If you use the operator console sync API, include `hubtiger_customer_by_phone.json` in `tool_files` (or use the repo tool catalog preview). After sync, confirm the tool URL is `https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/customer-by-phone`, not the legacy `/tool` router.

### Dynamic variables (auto-filled from response)

The JSON assigns these when `found` is true:

| Variable | Response field |
|----------|----------------|
| `customer_first_name` | `first_name` |
| `customer_last_name` | `last_name` |
| `customer_name` | `Name` |
| `workshop_jobcard` | `Jobcard` |
| `vehicle_model` | `Model` |
| `workshop_location` | `Location` |
| `workshop_checked_in` | `DateCheckedIn` |

**Prompt hint:** “When you have the caller’s mobile, call `hubtiger_customer_by_phone` once at the start. If `found` is true, greet with `first_name`. Use `vehicle_model`, `workshop_jobcard`, and `workshop_location` only when discussing their open workshop job. Do not read `customer_id` aloud.”

---

## Relation to other HubTiger URLs

| Surface | URL | Use case |
|---------|-----|----------|
| **This doc** | `/api/elevenlabs/hubtiger/customer-by-phone` | Fast name-by-phone |
| Magic Mike tools | `/api/elevenlabs/hubtiger/tool` | Jobs, booking, availability |
| Legacy Ghost tool registry | `https://ghost.rideai.com.au/api/tools/a1824fdc-…/execute` | `scripts/hubtiger/hubtiger_customer_search.json` (`operation: customer_search`) — different host |
| Agent ingress alias | `/agent/integrations/elevenlabs/hubtiger/tool` | Same as `/tool`, not this route |

---

## Deploy / verify after code changes

```bash
cd /var/llamaindex/ghoststack-rag
docker compose up -d --build control-api hubtiger-mcp
docker compose exec -T control-api python -c "
import asyncio
from ghostdash_api.hubtiger_customer_lookup import lookup_customer_by_phone
async def main():
    r = await lookup_customer_by_phone(phone='0435185134', trace_id='verify-doc')
    print(r.model_dump())
asyncio.run(main())
"
```

Automated tests:

```bash
python3.12 -m pytest backend/tests/test_hubtiger_customer_by_phone.py -q
```

---

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| HTTP 401 | Wrong/missing `X-Ghost-Voice-Key` | Match `.env` `ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` |
| `hubtiger_timeout` | HubTiger portal slow | Retry; raise `HUBTIGER_CUSTOMER_LOOKUP_TIMEOUT_MS` |
| `found: false` | Number not in HubTiger cyclists | Confirm mobile in workshop system; try `04` format |
| `success: false` + “unavailable” on **`/tool`** | 6s `HUBTIGER_READ_TIMEOUT_MS` on job search | Use **this** endpoint for names; use phone on `job_search` for jobs |
| Works on server, fails remotely | DNS/firewall | Use `ghoststack.rideai.com.au` HTTPS only |

Structured logs (no full PII in message bodies) use route:

`control-api` → `/api/elevenlabs/hubtiger/customer-by-phone` with `trace_id`, `phone`, `found`, `status`.

---

## Source files (repo)

| File | Role |
|------|------|
| `backend/src/ghostdash_api/integrations/hubtiger_elevenlabs_tool.py` | HTTP route |
| `backend/src/ghostdash_api/hubtiger_customer_lookup.py` | Lookup + timeout + name parsing |
| `backend/src/ghostdash_api/hubtiger_mcp.py` | `customer_search` → MCP execute |
| `services/hubtiger-mcp/index.js` | MCP → `GET /customers/search` |
| `scripts/hubtiger/hubtiger-proxy/index.js` | `portalSearchCyclists` upstream |
| `backend/tests/test_hubtiger_customer_by_phone.py` | Tests |
| `scripts/hubtiger/hubtiger_customer_by_phone.json` | ElevenLabs import JSON |
