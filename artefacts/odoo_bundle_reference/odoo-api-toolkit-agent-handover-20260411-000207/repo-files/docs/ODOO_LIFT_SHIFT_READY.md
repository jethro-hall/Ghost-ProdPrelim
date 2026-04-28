# Odoo Lift-and-Shift Ready Pack

## Purpose

This document packages the Odoo connector state that exists in GhostDash today so another agent or operator can lift and shift the Odoo integration to another server with minimal discovery work.

This is not the Odoo connector codebase itself.

This repository contains:

- the GhostDash control-plane integration for `odoo_rpc`
- the UI touch points for Odoo tool execution
- the database-backed tool rows
- the API contract GhostDash expects from an external Odoo module

This repository does not contain:

- an `odoo-rpc` service in `docker-compose.yml`
- the external Odoo connector implementation
- the Odoo backend deployment itself

## Current Live Status

As of this capture, Odoo is **configured in GhostDash but not reachable** from the running stack.

### Live evidence

- `tools` table contains active `odoo_rpc` rows
- the newest Odoo tool row points to `http://odoo-rpc:8097`
- `POST /api/tools/:id/test` returns `502`
- `POST /api/tools/:id/execute` returns `502`
- direct fetch from `ghost-control-plane` to `http://odoo-rpc:8097/health` fails
- no `odoo-rpc` container appears in the current `docker ps` output

### What that means

GhostDash is ready to call Odoo, but the Odoo module endpoint it is configured to use is not currently reachable inside this stack.

For lift-and-shift, the receiving server must supply the external Odoo module and make it reachable to `ghost-control-plane`.

## What Exists in the Live Database

Live Odoo tool rows observed:

| Tool ID | Name | Kind | Status | Config |
|---------|------|------|--------|--------|
| `591461d7-452c-4072-880a-1afd328357c4` | `Odoo ERP Gateway QA` | `odoo_rpc` | `active` | `{"base_url":"http://odoo-rpc:8097","test_path":"/health","module_url":"","execute_path":"/tool"}` |
| `47a505da-4cd9-47fe-8024-3ae6afd33799` | `Odoo ERP Gateway` | `odoo_rpc` | `active` | `{"version":"v1","test_path":"/health","execute_path":"/tool"}` |
| `c7ecb555-db25-40e8-93cf-4a0d7dfed3a8` | `Odoo ERP` | `odoo_rpc` | `active` | `{"version":"v1"}` |

### Recommended row to move

Use the newest explicit module row as the canonical starting point:

- Tool ID: `591461d7-452c-4072-880a-1afd328357c4`
- Base URL: `http://odoo-rpc:8097`
- Test path: `/health`
- Execute path: `/tool`

## GhostDash Contract for the Odoo Module

GhostDash control-plane expects the Odoo module to expose exactly:

### 1) Health endpoint

```http
GET /health
Headers:
  x-trace-id: <uuid>
  x-span-id: <uuid>
  x-internal-key: <optional>
  Authorization: Bearer <optional>
```

Expected behavior:

- returns a success body on healthy connector startup
- reachable from `ghost-control-plane`

### 2) Tool endpoint

```http
POST /tool
Content-Type: application/json
Headers:
  x-trace-id: <uuid>
  x-span-id: <uuid>
  x-internal-key: <optional>
  Authorization: Bearer <optional>

{
  "operation": "<string>",
  "payload": {},
  "tool_id": "<uuid>"
}
```

Expected behavior:

- accepts Odoo operations from GhostDash
- returns JSON payloads
- does not require any browser-direct access

## Current Odoo Operations GhostDash Can Send

Operations already used in the UI and documented in the control-plane:

- `odoo.current_user`
- `odoo.products.search`
- `odoo.customers.search`
- `odoo.sale_orders.search`
- `odoo.invoices.search`
- `odoo.search_read`
- `odoo.execute_kw`

These are forwarded opaquely by GhostDash. The receiving Odoo module must implement the behavior for them.

## Repo Touch Points to Move With GhostDash

These are the Odoo-related integration points in this repo:

- `server/control-plane/index.js`
- `src/pages/Tools.tsx`
- `src/pages/IntegrationLab.tsx`
- `docs/ODOO_OPENAI_CHAT_E2E.md`
- `docs/ARCHITECTURE_HANDOVER_HUBTIGER_ODOO.md`
- `.env`

### What the control-plane already does

- seeds `odoo_rpc` tool rows
- sanitizes secret fields out of public tool config
- calls the Odoo module for `/test`
- calls the Odoo module for `/execute`
- writes trace/log rows to `request_logs`

## Environment Variables Needed on the Destination Server

At minimum, the destination GhostDash server must provide:

```bash
ODOO_RPC_URL=<reachable odoo module base url>
ODOO_RPC_INTERNAL_KEY=<optional internal key>
ODOO_RPC_API_TOKEN=<optional bearer token>
```

Optional or legacy values seen in `.env`:

```bash
ODOO_URL=<upstream odoo instance url if your module uses it>
ODOO_DB=<database name if your module uses it>
ODOO_USERNAME=<service login if your module uses it>
ODOO_API_KEY=<service api key if your module uses it>
```

Important:

- `ODOO_RPC_*` is the GhostDash runtime contract.
- `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, and `ODOO_API_KEY` only matter if the external Odoo module is designed to consume them.
- An upstream `ODOO_API_KEY` has been supplied for operations, but it is intentionally not persisted verbatim in this handover file or the JSON artifact. Transfer it to the destination connector through a secure secret channel only.

## What Must Be Shipped Outside This Repo

To complete the lift-and-shift, the receiving team still needs the external Odoo connector artifact.

Minimum required deliverable outside this repo:

1. a service or container reachable as `http://odoo-rpc:8097` or equivalent private URL
2. support for `GET /health`
3. support for `POST /tool`
4. Odoo credentials held inside that service, including the supplied upstream `ODOO_API_KEY` if that connector implementation requires it
5. JSON responses for the operation list above

### Recommended deployment shape

- Container name: `odoo-rpc` or another private hostname
- Private port: `8097`
- Network visibility: private, server-to-server only
- Browser exposure: none

## Current Gap Blocking Lift-and-Shift Completion

The blocking gap is not in the GhostDash code path.

The blocking gap is:

- the current live stack points to `http://odoo-rpc:8097`
- no live `odoo-rpc` service is reachable from `ghost-control-plane`

Until that service exists on the destination side, Odoo lift-and-shift is not operational.

## UI Caveat the Receiving Team Must Know

The current GhostDash UI can show Odoo as offline even when control-plane envs are present because the UI readiness check does not match the public config fields exposed by the server.

That is a known follow-up and should not be used as the sole truth for operational readiness.

## Lift-and-Shift Steps

1. Move the GhostDash repo and containers to the destination host.
2. Deploy the external Odoo connector service on the destination host or a reachable private host.
3. Set `ODOO_RPC_URL` to the connector base URL, or update the live `odoo_rpc` tool row with the correct `base_url`.
4. Apply `ODOO_RPC_INTERNAL_KEY` and/or `ODOO_RPC_API_TOKEN` if the connector requires them.
5. Verify the GhostDash control-plane can reach the Odoo connector health route.
6. Verify `odoo.current_user` succeeds through `/api/tools/:id/execute`.
7. Only then treat Odoo as truly migrated.

## Exact Verify Commands

### Confirm live Odoo rows

```bash
docker exec ghost-postgres psql -U ghost -d ghost -c "SELECT id,name,kind,status,config FROM tools WHERE kind='odoo_rpc' ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST;"
```

### Resolve the newest Odoo tool id

```bash
docker exec ghost-postgres psql -U ghost -d ghost -t -A -c "SELECT id FROM tools WHERE kind='odoo_rpc' ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT 1;"
```

### Test GhostDash -> Odoo connector

```bash
docker exec ghost-control-plane wget -qO- --header='Content-Type: application/json' --post-data='{}' http://127.0.0.1:3000/api/tools/<ODOO_TOOL_ID>/test
```

### Execute a simple read

```bash
docker exec ghost-control-plane wget -qO- --header='Content-Type: application/json' --post-data='{"operation":"odoo.current_user","payload":{}}' http://127.0.0.1:3000/api/tools/<ODOO_TOOL_ID>/execute
```

### Prove direct control-plane reachability to the module

```bash
docker exec ghost-control-plane node -e "fetch('http://odoo-rpc:8097/health').then(async r=>{console.log(r.status);console.log(await r.text())}).catch(e=>console.log(String(e.message||e)))"
```

## Acceptance Criteria

- The destination server has a reachable Odoo module endpoint.
- GhostDash has an `odoo_rpc` row pointing to that endpoint.
- `/api/tools/<ODOO_TOOL_ID>/test` returns `ok: true`.
- `/api/tools/<ODOO_TOOL_ID>/execute` returns `ok: true` with Odoo data.
- The receiving team understands that the external Odoo connector service is required and is not contained in this repo.
