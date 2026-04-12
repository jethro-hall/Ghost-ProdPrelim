# Odoo API Toolkit Agent Handover

## What was built

A concrete Odoo gateway was added at `services/odoo-rpc/` and wired into GhostDash.

Primary files:

- `services/odoo-rpc/index.js`
- `services/odoo-rpc/Dockerfile`
- `services/odoo-rpc/package.json`
- `docker-compose.yml`
- `server/control-plane/index.js`
- `src/pages/Tools.tsx`
- `src/pages/IntegrationLab.tsx`
- `docs/ODOO_API_TOOLKIT_BUILD.md`

## What is live right now

Current container status at handoff time:

- `ghost-odoo-rpc`: healthy
- `ghost-control-plane`: healthy
- `ghost-control-plane-canary`: healthy
- `ghost-web-ui`: up
- `ghost-edge-gateway`: up
- `ghost-redis`: up, `role:master`

Current edge health:

- `https://ghost.rideai.com.au/api/health` returns `200 {"ok":true}`

Current Redis state:

- `role:master`
- `connected_slaves:0`

## What was verified

Verified through the control-plane, not just directly against `odoo-rpc`:

- Odoo tool `test` succeeds
- Odoo finance execute succeeds using `odoo.finance.receivables.open`
- Odoo returns live receivables rows

Known working Odoo tool ID at handoff time:

- `591461d7-452c-4072-880a-1afd328357c4`

## Critical truth the next agent must not miss

The human reported: "that's the old dashboard".

Do not assume the visual/dashboard result matched the user's expectation just because:

- the rebuilt web container served a fresh asset bundle
- the API path passed
- the new Odoo operation strings existed in the deployed JS bundle

This means one of these is still unresolved:

1. The wrong visual surface/page was checked.
2. The user expected a different dashboard route/component than `Tools` / `IntegrationLab`.
3. The dashboard change is present in source and bundle, but still not obvious enough in the UI.
4. A cached or alternate client path was still being observed by the user.

Treat the UI acceptance as **not complete**.

## Critical runtime issue found during redeploy

The redeploy exposed an unrelated but serious platform drift:

- `ghost-redis` had become a replica of external `109.244.159.27:23021`
- BullMQ startup writes failed with `READONLY You can't write against a read only replica`
- both control-plane containers crash-looped

This was repaired live by promoting Redis back to standalone master:

- `redis-cli REPLICAOF NO ONE`

After repair:

- `ghost-control-plane` recovered
- `ghost-control-plane-canary` recovered
- edge health returned to `200`

The repo does **not** configure Redis as a replica. This was runtime drift.

## What the next agent should do

1. Start from human acceptance, not from API proof.
2. Open the real user-facing dashboard and identify exactly which page the user means by "old dashboard".
3. Compare the current live UI against:
   - `src/pages/Tools.tsx`
   - `src/pages/IntegrationLab.tsx`
   - route wiring in `src/App.tsx`
   - layout/nav exposure in `src/components/Layout.tsx`
4. Confirm whether the expected Odoo affordances are visible without needing to inspect JS bundles.
5. If not visible enough, make the UI state unmistakable and re-test with a human.

## Exact verify commands

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | rg 'ghost-control-plane|ghost-control-plane-canary|ghost-odoo-rpc|ghost-web-ui|ghost-edge-gateway|ghost-redis'
curl -k -i --max-time 10 https://ghost.rideai.com.au/api/health
docker exec ghost-redis redis-cli INFO replication
docker exec ghost-control-plane node -e "fetch('http://127.0.0.1:3000/api/tools/591461d7-452c-4072-880a-1afd328357c4/test',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(async (r)=>{const text=await r.text(); console.log(text); process.exit(r.ok?0:1);}).catch((e)=>{console.error(e); process.exit(1);})"
docker exec ghost-control-plane node -e "fetch('http://127.0.0.1:3000/api/tools/591461d7-452c-4072-880a-1afd328357c4/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'odoo.finance.receivables.open',payload:{limit:3}})}).then(async (r)=>{const text=await r.text(); console.log(text); process.exit(r.ok?0:1);}).catch((e)=>{console.error(e); process.exit(1);})"
```

## Human test required

The next agent must perform or drive a human test of the live UI:

1. Open the live dashboard page the user actually means.
2. Confirm whether the Odoo changes are visible and understandable.
3. Run an Odoo action from the UI, not just through CLI/API.
4. Report mismatch against the user's expected dashboard plainly.
