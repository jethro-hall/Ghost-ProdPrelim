# HubTiger Lookup-Only Restore

Date: 2026-04-29

## Requirement

Restore HubTiger job lookup by phone/name with the leanest possible change, without dragging write-mode portal auth into lookup-only reads.

## Root Cause

Two issues were blocking the live lookup path:

1. `scripts/hubtiger/hubtiger-proxy/index.js` sent `/jobs/search` to the legacy REST upstream unless `PORTAL_MODE` was enabled.
2. The local runtime config had `HUBTIGER_PARTNER_ID` unset, so the HAR-confirmed `JobCardSearch` contract could not be used.

The HAR proved the real lookup contract is:

- `POST https://hubtigerservices.azurewebsites.net/api/ServiceRequest/JobCardSearch`
- JSON body: `{"PartnerID":2186,"Search":"<name or phone>","SearchAllStores":false|true}`
- No bearer token required for this search call

## Correct Layer

`hubtiger-proxy` owns the upstream HubTiger request shape, so the fix belongs there.

## Files Changed

- `scripts/hubtiger/hubtiger-proxy/index.js`
- `scripts/hubtiger/hubtiger-proxy/index.test.js`
- `.env`

## Changes Made

### Proxy

- Added `buildPortalJobSearchRequest()` to encode the HAR-confirmed lookup request.
- Removed the fake dependency on portal login for `JobCardSearch`.
- Changed `/jobs/search` to use the HubTiger services lookup path whenever `HUBTIGER_PARTNER_ID` is configured, even when `PORTAL_MODE` is off.
- Kept write/detail endpoints on their existing portal-specific paths.
- Exported the proxy app and helper functions so the lookup contract can be tested without starting the server.
- Fixed customer-name mapping so results prefer `CyclistDescription` and do not render blank names.

### Runtime Config

- Set `HUBTIGER_PARTNER_ID=2186` in local `.env` so the live container can issue lookup-only searches.

## Architecture Impact

- No new routes
- No new service
- No schema changes
- No duplicated settings surface
- Lookup-only reads now use the correct upstream contract
- Portal-only writes remain separately gated

## Tests Run

### Focused proxy tests

```bash
docker run --rm -v "/var/llamaindex/ghoststack-rag/scripts/hubtiger/hubtiger-proxy:/src:ro" node:20-alpine sh -lc "cp -r /src /tmp/app && cd /tmp/app && npm install >/tmp/npm-install.log 2>&1 && node --test index.test.js"
```

Output:

- 3 tests passed
- 0 failed

Covered:

- HAR-aligned lookup request shape
- fail-closed behavior without partner id
- customer-name mapping from `CyclistDescription`

## Live Verification

### Upstream contract proof

```bash
curl -sS -X POST https://hubtigerservices.azurewebsites.net/api/ServiceRequest/JobCardSearch -H 'Content-Type: application/json' -d '{"PartnerID":2186,"Search":"0435185134","SearchAllStores":false}'
```

Result: returned 3 Ride Electric jobs for `Jeff Hall`.

### End-to-end GhostDASH API proof

```bash
curl -sS -X POST http://127.0.0.1/api/hubtiger/test -H 'Content-Type: application/json' -d '{"operation":"job_lookup","payload":{"phone":"0435185134"}}'
```

Result: `success=true`, `count=3`, with customer name `Jeff Hall` and valid job cards `#35872`, `#34155`, `#34249`.

## Manual Verification Steps

1. Open GhostDASH.
2. Go to the HubTiger test surface or any operator flow that triggers `job_lookup`.
3. Search using phone `0435185134`.
4. Confirm results list shows:
   - customer name `Jeff Hall`
   - job cards including `#35872`
   - bike descriptions such as `Fatfish Biggie`

## Cleanup Performed

- No duplicate route added
- No fallback auth shim added
- No write-path behavior changed

## Known Risks

- Lookup-only search still depends on `HUBTIGER_PARTNER_ID` being present in runtime config.
- Name-search parity is expected from the same upstream contract, but this pass was live-verified with phone lookup because that was the concrete HAR evidence available.
