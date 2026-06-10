# HubTiger Booking Availability Handover

**ElevenLabs / LLM (live):** See [`HUBTIGER_BOOKING_AVAILABILITY_ELEVENLABS_LLM_GUIDE.md`](./HUBTIGER_BOOKING_AVAILABILITY_ELEVENLABS_LLM_GUIDE.md) for agent prompts, response scripts, and go-live checklist.

## Objective

Fix HubTiger workshop booking availability for Ride Electric so ElevenLabs / Magic Mike can call:

```json
{
  "function": "booking_availability",
  "store": "brisbane",
  "cache_mode": "no_cache",
  "payload": {
    "store": "brisbane",
    "start_date": "2026-05-22",
    "days": 14,
    "service_type": "workshop"
  }
}
```

and receive real workshop availability from HubTiger.

---

## Active project paths

The correct active source paths are:

```text
/var/llamaindex/ghoststack-rag/services/hubtiger-mcp/index.js
/var/llamaindex/ghoststack-rag/scripts/hubtiger/hubtiger-proxy/index.js
```

Do **not** patch:

```text
/var/llamaindex/ghoststack-rag/hubtiger-mcp/
```

That directory caused earlier confusion. Docker Compose builds from:

```text
services/hubtiger-mcp
scripts/hubtiger/hubtiger-proxy
```

---

## Docker services involved

Relevant services:

```text
hubtiger-mcp
hubtiger-proxy
control-api
agent-ingress
caddy
```

`hubtiger-mcp` depends on `hubtiger-proxy`.

Relevant internal URLs:

```text
hubtiger-mcp:8096
hubtiger-proxy:8095
```

Public ElevenLabs endpoint:

```text
https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool
```

---

## Current architecture

Correct intended architecture:

```text
ElevenLabs
→ agent-ingress / control-api
→ hubtiger-mcp
→ hubtiger-proxy
→ HubTiger portal/API
```

The final design decision is:

```text
MCP must not know HubTiger auth.
ElevenLabs must not know HubTiger auth.
hubtiger-proxy owns all HubTiger auth.
```

---

## Critical auth finding

The HubTiger `code=` value is **not** stored in `.env`.

These are blank in `.env`:

```env
HUBTIGER_FUNCTION_CODE=
HUBTIGER_API_CODE=
```

A fresh HAR showed the portal frontend bundle contains the dynamic value as something like:

```js
PRO_API_KEY = "<function code>"
```

That frontend bundle is loaded from:

```text
https://hubtigerportal.azurewebsites.net/main.<hash>.js
```

The proxy was patched to dynamically resolve this `PRO_API_KEY` from the portal JS bundle instead of requiring it in `.env`.

---

## HubTiger has two API families

This was the key source of confusion.

### 1. Legacy/services API

Used by job search.

Host:

```text
https://hubtigerservices.azurewebsites.net
```

Example endpoint:

```text
/api/ServiceRequest/JobCardSearch
```

Auth style:

```text
PartnerID payload/header style
No bearer token
No function code required directly
```

Proxy code showed `portalSearchJobs()` directly calls `JobCardSearch` and logs `auth_mode: 'none'`.

### 2. Azure portal/API

Used by calendar/availability.

Host:

```text
https://hubtiger-api.azurewebsites.net
```

Important endpoints:

```text
/api/Auth/ValidateLogin?code=<PRO_API_KEY>
/api/Technician/Calendar/Data?code=<PRO_API_KEY>
/api/v4.0/Services/TechniciansAvailabilityV3?code=<PRO_API_KEY>
```

Auth style:

```text
Dynamic PRO_API_KEY from portal JS bundle
ValidateLogin with portal username/password
Bearer token required for availability
```

---

## Current `.env` requirements

API key can stay blank:

```env
HUBTIGER_API_KEY=
HUBTIGER_FUNCTION_CODE=
HUBTIGER_API_CODE=
```

Required for portal bearer login:

```env
HUBTIGER_AUTH_MODE=portal
HUBTIGER_PORTAL_MODE=true
HUBTIGER_PARTNER_ID=2186
HUBTIGER_USERNAME=ian@rideelectric.com.au
HUBTIGER_PASSWORD=<real HubTiger portal password>
```

Current password used during testing was fake, so bearer login cannot succeed until replaced with the real one.

---

## MCP current state

File:

```text
services/hubtiger-mcp/index.js
```

Booking availability now calls the proxy route:

```text
/availability/technicians
```

not the raw HAR endpoint:

```text
/api/Services/TechniciansAvailableSlots
```

MCP sends query params in this shape:

```text
store=brisbane
fromDate=2026-05-22
toDate=2026-06-04
technicians=1489
requiredMinutes=60
```

The MCP direct test reached the availability function and returned normalized responses correctly.

A successful MCP-level call returned:

```json
{
  "ok": true,
  "operation": "availability_lookup",
  "status": 200,
  "data": {
    "success": true,
    "operation": "availability_lookup",
    "data": {
      "store": "brisbane",
      "store_label": "Ride Electric Brisbane",
      "technician_id": 1489,
      "slot_count": 0,
      "first_slots": [],
      "source": "hubtiger proxy availability/technicians"
    }
  }
}
```

This proved MCP routing and normalization are working.

---

## Proxy current state

File:

```text
scripts/hubtiger/hubtiger-proxy/index.js
```

Important route:

```js
app.get('/availability/technicians', (req, res) => {
  if (PORTAL_MODE || HUBTIGER_PARTNER_ID) {
    return portalTechnicianAvailability(req, res)
  }
  ...
});
```

Important function:

```js
async function portalTechnicianAvailability(req, res) { ... }
```

The function currently calls:

```text
/api/v4.0/Services/TechniciansAvailabilityV3
```

via `portalFetch()`.

It was temporarily changed to `auth: 'none'`, but the upstream response proved that is wrong.

The endpoint returned:

```text
Please add the bearer token to the header
```

This proves `TechniciansAvailabilityV3` requires bearer auth.

---

## Required next fix

Patch only `portalTechnicianAvailability()` so its availability call uses:

```js
auth: 'bearer'
```

not:

```js
auth: 'none'
```

Likely also keep calendar discovery call as bearer if it hits Azure portal/API.

Current source should be checked with:

```bash
cd /var/llamaindex/ghoststack-rag

sed -n '1075,1165p' scripts/hubtiger/hubtiger-proxy/index.js | grep -n "auth:"
```

Expected inside `portalTechnicianAvailability()`:

```js
auth: 'bearer',
```

Patch command:

```bash
cd /var/llamaindex/ghoststack-rag

cp scripts/hubtiger/hubtiger-proxy/index.js scripts/hubtiger/hubtiger-proxy/index.js.bak.availability-bearer.$(date -u +%Y%m%dT%H%M%SZ)

python3 - <<'PY'
from pathlib import Path

path = Path("scripts/hubtiger/hubtiger-proxy/index.js")
text = path.read_text()

fn_start = text.find("async function portalTechnicianAvailability")
if fn_start == -1:
    raise SystemExit("portalTechnicianAvailability not found")

next_fn = text.find("\nasync function ", fn_start + 1)
if next_fn == -1:
    raise SystemExit("Could not find end of portalTechnicianAvailability")

before = text[:fn_start]
fn = text[fn_start:next_fn]
after = text[next_fn:]

count = fn.count("auth: 'none',")
fn = fn.replace("auth: 'none',", "auth: 'bearer',")

path.write_text(before + fn + after)
print(f"[OK] replaced {count} auth entries inside portalTechnicianAvailability")
PY

node --check scripts/hubtiger/hubtiger-proxy/index.js
```

Then verify:

```bash
sed -n '1075,1165p' scripts/hubtiger/hubtiger-proxy/index.js | grep -n "auth:"
```

---

## Dynamic PRO_API_KEY resolver

Proxy should contain dynamic resolver logic similar to:

```js
let HUBTIGER_FUNCTION_CODE =
  process.env.HUBTIGER_FUNCTION_CODE || process.env.HUBTIGER_API_CODE || '';

let functionCodeCache = {
  value: HUBTIGER_FUNCTION_CODE || '',
  fetchedAt: 0,
};

async function resolveHubTigerFunctionCode({ forceRefresh = false } = {}) {
  const ttlMs = 6 * 60 * 60 * 1000;
  const now = Date.now();

  if (!forceRefresh && functionCodeCache.value && now - functionCodeCache.fetchedAt < ttlMs) {
    return functionCodeCache.value;
  }

  if (!forceRefresh && HUBTIGER_FUNCTION_CODE) {
    functionCodeCache = { value: HUBTIGER_FUNCTION_CODE, fetchedAt: now };
    return HUBTIGER_FUNCTION_CODE;
  }

  const portalRoot = (process.env.HUBTIGER_PORTAL_URL || 'https://hubtigerportal.azurewebsites.net').replace(/\/$/, '');

  const rootResponse = await fetch(`${portalRoot}/`);
  const rootHtml = await rootResponse.text();

  const mainMatch =
    rootHtml.match(/(?:src=)["']([^"']*main\.[^"']+\.js)["']/i) ||
    rootHtml.match(/([^"']*main\.[a-zA-Z0-9]+\.js)/i);

  if (!mainMatch) {
    throw new Error('hubtiger_portal_main_bundle_not_found');
  }

  const mainUrl = mainMatch[1].startsWith('http')
    ? mainMatch[1]
    : `${portalRoot}/${mainMatch[1].replace(/^\//, '')}`;

  const bundleResponse = await fetch(mainUrl);
  const bundleText = await bundleResponse.text();

  const codeMatch =
    bundleText.match(/PRO_API_KEY\s*=\s*["']([^"']+)["']/) ||
    bundleText.match(/PRO_API_KEY["']?\s*[:=]\s*["']([^"']+)["']/) ||
    bundleText.match(/code=([A-Za-z0-9_\-]+={0,2})/);

  if (!codeMatch || !codeMatch[1]) {
    throw new Error('hubtiger_portal_pro_api_key_not_found');
  }

  HUBTIGER_FUNCTION_CODE = codeMatch[1];
  functionCodeCache = { value: HUBTIGER_FUNCTION_CODE, fetchedAt: now };
  return HUBTIGER_FUNCTION_CODE;
}
```

`portalApiUrlAsync()` should use that resolver:

```js
async function portalApiUrlAsync(path, query = {}) {
  const resolvedCode = query.code ?? await resolveHubTigerFunctionCode();
  const qs = buildQuery({ ...query, code: resolvedCode });
  return `${HUBTIGER_API_URL}${path}?${qs.toString()}`;
}
```

`portalFetch()` should call:

```js
const url = api === 'services'
  ? portalServicesUrl(path, query)
  : await portalApiUrlAsync(path, query);
```

`portalLogin()` should call:

```js
const functionCode = await resolveHubTigerFunctionCode();
const loginUrl = `${HUBTIGER_API_URL}/api/Auth/ValidateLogin?code=${encodeURIComponent(functionCode)}`;
```

Confirm with:

```bash
grep -nE "resolveHubTigerFunctionCode|portalApiUrlAsync|PRO_API_KEY|ValidateLogin" scripts/hubtiger/hubtiger-proxy/index.js
```

---

## Row parsing / debug state

The availability response returned:

```text
upstreamShape: string
parsedShape: string
upstreamStringSample: Please add the bearer token to the header
```

So row parsing is not the primary issue anymore. The upstream says bearer is missing.

There is a temporary debug parser in `portalTechnicianAvailability()` around lines near `1164` that parses JSON-string payloads. Keep it for now until real bearer auth succeeds.

There is also an accidental parser block around line `449` inside `fetchProductsCatalogFromUpstream()`. It appears to have been introduced by an overbroad patch. It should be reviewed and probably reverted, because product catalog fetch should not use `availabilityPayload` naming.

Recommended cleanup later:

```text
Remove availabilityPayload parsing from fetchProductsCatalogFromUpstream()
Keep availabilityPayload parsing only in portalTechnicianAvailability()
```

Do not do this until availability works.

---

## Rebuild / restart commands

Use these after patching:

```bash
cd /var/llamaindex/ghoststack-rag

docker compose stop hubtiger-proxy hubtiger-mcp
docker compose rm -f hubtiger-proxy hubtiger-mcp

docker compose build --no-cache hubtiger-proxy hubtiger-mcp
docker compose up -d hubtiger-proxy hubtiger-mcp control-api agent-ingress
```

Check running services:

```bash
docker compose ps hubtiger-proxy hubtiger-mcp control-api agent-ingress
```

If MCP is not running:

```bash
docker compose logs --tail=120 hubtiger-mcp
```

If proxy is not running:

```bash
docker compose logs --tail=120 hubtiger-proxy
```

---

## Verify proxy env

```bash
docker compose exec hubtiger-proxy sh -c '
echo "HUBTIGER_AUTH_MODE=${HUBTIGER_AUTH_MODE}"
echo "HUBTIGER_PORTAL_MODE=${HUBTIGER_PORTAL_MODE}"
echo "HUBTIGER_PARTNER_ID=${HUBTIGER_PARTNER_ID}"
if [ -n "$HUBTIGER_USERNAME" ]; then echo "HUBTIGER_USERNAME=SET"; else echo "HUBTIGER_USERNAME=EMPTY"; fi
if [ -n "$HUBTIGER_PASSWORD" ]; then echo "HUBTIGER_PASSWORD=SET"; else echo "HUBTIGER_PASSWORD=EMPTY"; fi
if [ -n "$HUBTIGER_FUNCTION_CODE" ]; then echo "HUBTIGER_FUNCTION_CODE=SET_STATIC"; else echo "HUBTIGER_FUNCTION_CODE=EMPTY_DYNAMIC_EXPECTED"; fi
'
```

Expected:

```text
HUBTIGER_AUTH_MODE=portal
HUBTIGER_PORTAL_MODE=true
HUBTIGER_PARTNER_ID=2186
HUBTIGER_USERNAME=SET
HUBTIGER_PASSWORD=SET
HUBTIGER_FUNCTION_CODE=EMPTY_DYNAMIC_EXPECTED
```

---

## Proxy test

Install curl into MCP container if needed:

```bash
docker compose exec -u root hubtiger-mcp sh -c 'apk add --no-cache curl'
```

Test proxy route:

```bash
docker compose exec hubtiger-mcp sh -c '
curl -sS "$HUBTIGER_PROXY_URL/availability/technicians?store=brisbane&fromDate=2026-05-22&toDate=2026-06-04&technicians=1489&requiredMinutes=60"
' | jq '{ok, error, status, message, upstreamStringSample, count, earliest, rows: (.rows[:2] // [])}'
```

Expected after bearer patch and valid password:

```json
{
  "ok": true,
  "error": null,
  "status": null,
  "message": null,
  "upstreamStringSample": null,
  "count": 0,
  "earliest": null,
  "rows": []
}
```

or rows if available.

If fake password:

```json
{
  "ok": false,
  "error": "portal_availability_failed",
  "message": "Portal login failed..."
}
```

If still no bearer:

```json
{
  "upstreamStringSample": "Please add the bearer token to the header"
}
```

That means the running container still has `auth: 'none'` in `portalTechnicianAvailability()` or the rebuild did not pick up the patched file.

---

## MCP direct test

```bash
docker compose exec -T hubtiger-mcp node - <<'NODE'
const body = {
  function: "booking_availability",
  store: "brisbane",
  cache_mode: "no_cache",
  payload: {
    store: "brisbane",
    start_date: "2026-05-22",
    days: 14,
    service_type: "workshop"
  }
};

fetch("http://127.0.0.1:8096/execute", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
})
  .then(async (r) => {
    console.log("STATUS", r.status);
    console.log(await r.text());
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
NODE
```

Expected after proxy works:

```text
STATUS 200
```

with a valid availability response.

---

## Booking offers voice rule (recommended + 2 backups)

For requests like *“2 June is my birthday — I need it serviced by then, what times between now and then?”* the agent should send:

```json
{
  "function": "booking_availability",
  "store": "brisbane",
  "payload": {
    "deadline_date": "2026-06-02",
    "scheduling_goal": "before_deadline",
    "customer_request": "Serviced before birthday on 2 June"
  }
}
```

`start_date` is optional — defaults to **today** through `deadline_date` (max 14 days scanned in one HubTiger call).

When slots exist, the API returns:

| Field | Meaning |
|--------|---------|
| `recommended_slot` | **Best fit** — for `before_deadline`, the **latest** opening on/before the deadline (maximises time before the event) |
| `backup_slots` | **Two alternatives** with times **closest** to the recommended slot |
| `booking_offers` | `[recommended, backup_1, backup_2]` with `rank`, `date`, `time`, `display` |
| `first_slots` / `closest_slots` | Same three `display` strings for voice |
| `message` | Customer-safe sentence listing recommended + backups |

Example voice line:

> “The best option to have your bike serviced before 2 June is 1 June at 2:00 pm. I can also offer 1 June at 9:00 am or 28 May at 10:00 am.”

If `slot_count` is `0`, do not invent times — offer another store, wider dates, or callback.

---

## API curl tests (5)

Set once per shell (do not commit the key):

```bash
export GHOST_API_BASE="https://ghoststack.rideai.com.au"
export GHOST_VOICE_KEY="YOUR_REAL_LOCAL_KEY_HERE"
```

### 1) Bridge health (MCP probe)

```bash
curl -sS "$GHOST_API_BASE/api/elevenlabs/hubtiger/health" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" | jq '{ok, ready, service, error_code}'
```

**Pass:** `ok: true`, `ready: true`.

### 2) Booking availability — single day (canonical)

```bash
curl -sS -X POST "$GHOST_API_BASE/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{
    "function": "booking_availability",
    "store": "brisbane",
    "start_date": "2026-05-22",
    "payload": {}
  }' | jq '{
    success,
    operation,
    message,
    slot_count: .data.data.slot_count,
    first_slots: .data.data.first_slots,
    closest_slots: .data.data.closest_slots
  }'
```

**Pass:** `success: true`, `operation: "availability_lookup"`. If `slot_count > 0`, then `first_slots` has **1–3** entries and they are the closest cluster (see rule above).

### 3) Birthday / “serviced by” request (deadline-aware)

Maps to: *“2 June is my birthday — I need it serviced by then, what times between now and then?”*

```bash
curl -sS -X POST "$GHOST_API_BASE/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{
    "function": "booking_availability",
    "store": "brisbane",
    "payload": {
      "deadline_date": "2026-06-02",
      "scheduling_goal": "before_deadline",
      "customer_request": "Birthday on 2 June, need bike serviced before then"
    }
  }' | jq '{
    success,
    message,
    slot_count: .data.slot_count,
    recommended_slot: .data.recommended_slot,
    backup_slots: .data.backup_slots,
    first_slots: .data.first_slots
  }'
```

**Pass:** `days_checked` matches window to deadline; `message` is customer-safe; when `slot_count > 0`, `recommended_slot` is set plus two `backup_slots` closest in time to it.

### 4) Closest availability — 14-day scan + no_cache

Use when the caller wants the **earliest cluster** of openings, not just one calendar day.

```bash
curl -sS -X POST "$GHOST_API_BASE/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{
    "function": "booking_availability",
    "store": "brisbane",
    "cache_mode": "no_cache",
    "payload": {
      "store": "brisbane",
      "start_date": "2026-05-22",
      "days": 14,
      "service_type": "workshop"
    }
  }' | jq '{
    success,
    slot_count: .data.data.slot_count,
    days_checked: .data.data.days_checked,
    first_slots: .data.data.first_slots
  }'
```

**Pass:** `days_checked: 14` (or the requested window). When slots exist, `first_slots` length ≤ 3 and spans the minimum time gap among any three openings in the window.

### 5) Second store (Southport)

```bash
curl -sS -X POST "$GHOST_API_BASE/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{
    "function": "booking_availability",
    "store": "southport",
    "start_date": "2026-05-22",
    "payload": {"days": 7}
  }' | jq '{success, store: .data.data.store, slot_count: .data.data.slot_count, first_slots: .data.data.first_slots}'
```

**Pass:** `store: "southport"`, `success: true` (zero slots is still success — offer another date).

### 6) Validation — missing store (expect HTTP 422)

```bash
curl -sS -w "\nHTTP %{http_code}\n" -X POST "$GHOST_API_BASE/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{
    "function": "booking_availability",
    "start_date": "2026-05-22",
    "payload": {}
  }' | jq .
```

**Pass:** HTTP `422` with a clear validation message (store required).

**Local alias (optional):** same operation via narrow path:

```bash
curl -sS -X POST "$GHOST_API_BASE/api/elevenlabs/hubtiger/booking_availability" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{"store":"brisbane","start_date":"2026-05-22","limit":14}' | jq .
```

---

## Root cause when calendar shows slots but API returned zero (fixed 2026-05-20)

| Bug | Symptom | Fix |
|-----|---------|-----|
| MCP read `openSlots` | Proxy returned `rows` with data; MCP saw empty array | Proxy now emits `openSlots` from `findAllAvailabilityCandidates()` |
| Hardcoded technician `1489` | Calendar uses **Kim (2730)** and **Hassler (6744)**; 1489 not in week | Omit `technicians=` on lookup; proxy defaults Brisbane to `2730,6744` |
| Payload allowlist dropped `days` | 14-day birthday scan became 1 day | Added `days`, `deadline_date`, `scheduling_goal` to control-api allowlist |

After fix, week **18–24 May 2026** returns **6 bookable slots** (e.g. Wed 20 May 12:15 Hassler, Thu 21 09:00 Kim, Fri 22 09:00 Kim).

## Current blocker

If availability is still empty after rebuild:

1. Confirm `hubtiger-proxy` and `hubtiger-mcp` containers were rebuilt (not stale).
2. Confirm portal bearer auth (`auth: 'bearer'` in `portalTechnicianAvailability()`).
3. Confirm `HUBTIGER_BRISBANE_AVAILABILITY_TECHNICIANS=2730,6744` (or calendar discovery finds Kim/Hassler).

---

## Useful verification commands

Check host file auth:

```bash
cd /var/llamaindex/ghoststack-rag
sed -n '1075,1165p' scripts/hubtiger/hubtiger-proxy/index.js | grep -n "auth:"
```

Check container file auth:

```bash
docker compose exec hubtiger-proxy sh -c "sed -n '1075,1165p' /app/index.js | grep -n \"auth:\""
```

Both must show:

```text
auth: 'bearer',
```

Check dynamic resolver exists in container:

```bash
docker compose exec hubtiger-proxy sh -c '
grep -nE "resolveHubTigerFunctionCode|portalApiUrlAsync|PRO_API_KEY|ValidateLogin" /app/index.js
'
```

---

## Recommended cleanup after it works

1. Remove temporary debug fields from availability response:

```text
upstreamShape
parsedShape
upstreamKeys
parsedKeys
upstreamStringLength
upstreamStringSample
parsedStringSample
```

2. Remove accidental `availabilityPayload` parser from `fetchProductsCatalogFromUpstream()`.

3. Keep JSON-string parser in `portalTechnicianAvailability()` if HubTiger returns arrays as strings.

4. Add regression tests for:

```text
dynamic PRO_API_KEY resolver
availability route uses bearer
MCP booking_availability calls /availability/technicians
zero slots is success, not failure
pickClosestAvailabilitySlots returns 3 clustered times when slots exist
```

5. Update operator prompt: if `slot_count = 0`, Magic Mike should say no open slots found and offer another date/store or callback. Do not say the system failed. When `first_slots` is present, offer **only those times** (max 3, closest together).
