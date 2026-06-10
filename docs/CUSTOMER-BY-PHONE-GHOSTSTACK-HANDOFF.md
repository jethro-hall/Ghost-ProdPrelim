# Ghoststack Handoff: Customer-by-Phone Jobcard Enrichment

**Purpose:** Deploy enriched `customer-by-phone` on ghoststack so curl returns customer name plus latest active workshop job (`model`, `jobcard`, `date_checked_in`, `location`).

**Canonical repo on ghoststack:** `/var/llamaindex/ghoststack-rag`  
**Upstream mirror (optional):** `jethro-hall/Ghost-AI-Dashboard` branch `integrate/help-website-assistant` (commits `635a9c9`, `cd2a989`, `3d57141`)

---

## Problem

Production may still return the **legacy** response (name only):

```json
{
  "success": true,
  "found": true,
  "phone": "0435185134",
  "first_name": "Jeff",
  "last_name": "Hall",
  "customer_id": "23889358"
}
```

After deploy, the same curl should include job fields (see Goal).

---

## Goal

```bash
export GHOST_VOICE_KEY="$(grep -E '^ELEVENLABS_HUBTIGER_WEBHOOK_SECRET=' /var/llamaindex/ghoststack-rag/.env | cut -d= -f2-)"

curl -sS -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/customer-by-phone" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{"phone":"0435185134"}' | jq .
```

**Expected:**

```json
{
  "success": true,
  "found": true,
  "phone": "0435185134",
  "first_name": "Jeff",
  "last_name": "Hall",
  "customer_id": "23889358",
  "model": "VSETT APEX 10+",
  "jobcard": "36658",
  "date_checked_in": "2026-05-23T13:40:00",
  "location": "Ride Electric"
}
```

PascalCase duplicates (`Name`, `Jobcard`, `Model`, `Workshop`, `Location`, `DateCheckedIn`) are included for ElevenLabs dynamic variables.

### Field rules

| Field | Source |
|-------|--------|
| `first_name` / `last_name` | HubTiger cyclist search (`Name` / `Surname`) |
| `model` | Latest active job `BikeDescription` |
| `jobcard` | Latest job `JobCardNo` (no `#` prefix) |
| `date_checked_in` | `DateCheckedIn` or `DateBookedIn` |
| `location` | `PartnerDescription` or technician store inference |

**One job only:** newest active open job (excludes Collected / status 100).

---

## Architecture (ghoststack-rag)

```text
curl POST /api/elevenlabs/hubtiger/customer-by-phone
  → control-api (backend/src/ghostdash_api/integrations/hubtiger_elevenlabs_tool.py)
    → hubtiger-mcp POST /execute (operation: customer_search)
      → hubtiger-proxy GET /customers/search?q=…&type=phone
        1. HubTiger Search/Cyclists
        2. JobcardsMinimumV2/open/{partnerId}
        3. Match job by CyclistID OR phone (last 9 digits)
        4. Fallback: JobCardSearch by phone
        5. Latest active job only
```

---

## Files changed (ghoststack-rag)

| File | Change |
|------|--------|
| `scripts/hubtiger/hubtiger-proxy/index.js` | Job enrichment in `portalSearchCyclists` |
| `backend/src/ghostdash_api/hubtiger_customer_lookup.py` | Map `variables` / `jobcard` into API response |
| `backend/src/ghostdash_api/schemas.py` | Extended `HubTigerCustomerByPhoneResponse` |
| `backend/tests/test_hubtiger_customer_by_phone.py` | Job field tests |
| `scripts/deploy-customer-by-phone-live.sh` | One-shot deploy |
| `scripts/hubtiger/hubtiger_customer_by_phone.json` | ElevenLabs import JSON |
| `docs/HUBTIGER_CUSTOMER_BY_PHONE.md` | Operator reference |

---

## Deploy on ghoststack (DO THIS)

```bash
cd /var/llamaindex/ghoststack-rag
bash scripts/deploy-customer-by-phone-live.sh
```

Or manually:

```bash
cd /var/llamaindex/ghoststack-rag
docker compose up -d --build hubtiger-proxy hubtiger-mcp control-api
```

### Env check

```bash
grep -E '^(HUBTIGER_PORTAL_MODE|HUBTIGER_PARTNER_ID|HUB_USER|HUB_PASS|ELEVENLABS_HUBTIGER_WEBHOOK_SECRET|APP_VOICE_INGRESS_SECRET)=' .env
```

`X-Ghost-Voice-Key` must match `ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` and/or `APP_VOICE_INGRESS_SECRET`.

---

## Verify

```bash
# Public API
curl -sS -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/customer-by-phone" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \
  -d '{"phone":"0435185134"}' | jq .

# Internal proxy (from host on compose network)
docker compose exec -T hubtiger-proxy wget -qO- \
  'http://127.0.0.1:8095/customers/search?q=%2B61435185134&type=phone' | jq '.variables, .results[0].jobcard'

# Logs if jobcard empty
docker compose logs hubtiger-proxy --tail 50
docker compose logs control-api --tail 50
```

### Success criteria

- [ ] Response includes `model`, `jobcard`, `date_checked_in`, `location`
- [ ] Only one job (latest active)
- [ ] Jeff Hall `0435185134` returns plausible open job
- [ ] Missing `X-Ghost-Voice-Key` → 401

---

## Cursor prompt (copy-paste)

```text
Deploy customer-by-phone jobcard enrichment on ghoststack.
Read: docs/CUSTOMER-BY-PHONE-GHOSTSTACK-HANDOFF.md
Tasks:
1. cd /var/llamaindex/ghoststack-rag
2. bash scripts/deploy-customer-by-phone-live.sh
3. Verify ELEVENLABS_HUBTIGER_WEBHOOK_SECRET in .env
4. Test curl for phone 0435185134 — response MUST include model, jobcard, date_checked_in, location
5. If jobcard empty for Jeff Hall, check hubtiger-proxy logs and HubTiger portal auth
Do not change unrelated files. Report curl output before/after.
```

---

## Ghost-AI-Dashboard note

If your workflow uses `~/Ghost-AI-Dashboard` instead of `ghoststack-rag`, pull `integrate/help-website-assistant` there and run that repo’s deploy script. **Production ghoststack Caddy routes to ghoststack-rag `control-api`**, not Ghost-AI-Dashboard `control-plane-api`, unless you have explicitly migrated the stack.
