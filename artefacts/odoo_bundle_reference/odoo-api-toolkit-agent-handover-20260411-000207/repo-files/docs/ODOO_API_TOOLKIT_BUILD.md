# Odoo API Toolkit Build

## What this adds

This build introduces a real `odoo-rpc` service at `services/odoo-rpc/` and wires GhostDash to use it as the default Odoo gateway.

The browser still calls GhostDash `/api/*` only. Odoo credentials remain server-side.

## Service shape

- Container: `ghost-odoo-rpc`
- Internal port: `8097`
- Health route: `GET /health`
- Execute route: `POST /tool`
- Default compose URL for control-plane: `http://odoo-rpc:8097`

## Required environment

- `ODOO_URL`
- `ODOO_DB`
- `ODOO_USERNAME`
- `ODOO_API_KEY` or `ODOO_PASSWORD`

Optional:

- `ODOO_RPC_URL`
- `ODOO_RPC_INTERNAL_KEY`
- `ODOO_RPC_API_TOKEN`
- `ODOO_RPC_ALLOW_MUTATIONS`
- `ODOO_RPC_TIMEOUT_MS`

## Operation namespaces

Read-first named operations:

- `odoo.meta.current_user`
- `odoo.meta.version`
- `odoo.meta.companies.list`
- `odoo.masters.products.search`
- `odoo.masters.customers.search`
- `odoo.sales.orders.search`
- `odoo.finance.invoices.search`
- `odoo.finance.receivables.open`
- `odoo.finance.payables.open`
- `odoo.finance.journal_entries.search`
- `odoo.finance.payments.search`
- `odoo.finance.accounts.search`
- `odoo.purchasing.orders.search`
- `odoo.inventory.quants.search`
- `odoo.inventory.valuation.search`

Compatibility aliases remain supported:

- `odoo.current_user`
- `odoo.products.search`
- `odoo.customers.search`
- `odoo.sale_orders.search`
- `odoo.invoices.search`

Escape hatches:

- `odoo.search_read`
- `odoo.execute_kw`

`odoo.execute_kw` is read-only unless `ODOO_RPC_ALLOW_MUTATIONS=true`.

## GhostDash surfaces updated

- `docker-compose.yml`
  - Adds `odoo-rpc`
  - Points both control-plane instances at `http://odoo-rpc:8097` by default
- `server/control-plane/index.js`
  - Publishes derived Odoo readiness state to the UI without exposing secrets
- `src/pages/Tools.tsx`
  - Exposes finance-first operation namespaces and updated readiness messaging
- `src/pages/IntegrationLab.tsx`
  - Exposes the same Odoo namespace set for scenario-based testing

## Local verify

Build and start only the new service:

```bash
docker compose up -d --build odoo-rpc
```

Check health from inside the Ghost network:

```bash
docker exec ghost-control-plane sh -lc 'wget -qO- http://odoo-rpc:8097/health'
```

Run a finance operation directly:

```bash
docker exec ghost-control-plane sh -lc 'wget -qO- --header="Content-Type: application/json" --post-data='"'"'{"operation":"odoo.finance.receivables.open","payload":{"limit":5}}'"'"' http://odoo-rpc:8097/tool'
```

After recreating control-plane, verify through GhostDash:

```bash
docker exec ghost-postgres psql -U ghost -d ghost -t -A -c "SELECT id FROM tools WHERE kind='\''odoo_rpc'\'' ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT 1;"
docker exec ghost-control-plane sh -lc 'wget -qO- --header="Content-Type: application/json" --post-data="{}" http://127.0.0.1:3000/api/tools/$ODOO_TOOL_ID/test'
docker exec ghost-control-plane sh -lc 'wget -qO- --header="Content-Type: application/json" --post-data='"'"'{"operation":"odoo.finance.invoices.search","payload":{"limit":5}}'"'"' http://127.0.0.1:3000/api/tools/$ODOO_TOOL_ID/execute'
```

## Known boundary

This build creates the missing gateway service and the GhostDash wiring. A running Odoo instance behind `ODOO_URL` is still required for live data.
