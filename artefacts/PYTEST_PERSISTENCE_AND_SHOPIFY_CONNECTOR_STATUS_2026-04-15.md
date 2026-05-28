# Pytest Persistence and Shopify Connector Status (2026-04-15)

## Scope

- Make `pytest` persistent on host and backend containers.
- Validate whether Shopify Odoo connector flow is runtime-ready.

## Permanent pytest changes

### Host

- Installed with:
  - `python3 -m pip install --user -U pytest`
- Verified with:
  - `python3 -m pytest --version`

### Containers (persistent across rebuilds)

- Updated backend image build at `backend/Dockerfile`:
  - from: `pip install --no-cache-dir "."`
  - to: `pip install --no-cache-dir "." "pytest>=8.4.2"`
- Rebuilt and restarted:
  - `docker compose build workflow-runtime control-api agent-ingress`
  - `docker compose up -d workflow-runtime control-api agent-ingress`

## Verification evidence

### Host verification

- `python3 -m pytest --version`
- Result: `pytest 8.4.2`

### Backend container verification

- `docker exec ghoststack-rag-control-api-1 python -m pytest --version`
- `docker exec ghoststack-rag-agent-ingress-1 python -m pytest --version`
- `docker exec ghoststack-rag-workflow-runtime-1 python -m pytest --version`
- Result: `pytest 9.0.3` in all three backend containers.

## Shopify connector readiness check

### Direct tool execution

- Endpoint: `POST /api/tools/odoo_primary/execute`
- Operation: `odoo.finance.shopify.monthly_roi`
- Payload: `date_from=2024-07-01`, `date_to=2026-07-01`, `relative_period=fy25_to_fy25_26`, `company_id=3`
- Runtime result:
  - `success: true`
  - `operation: odoo.finance.shopify.monthly_roi`
  - `rows: 22`
  - `line_count: 3010`
  - `group_totals.shopify_revenue: 469574.97999999975`
  - `revenue_source_mode: shopify_journal_ar_lines`
  - `journals_used: 13`
  - `accounts_used: 5`
  - `vendors_used: 27`
  - `attribution_note: present`

### End-to-end agent execution

- Endpoint: `POST /agent/chat`
- Prompt: user’s Shopify ROI/Odoo-only instruction.
- Tool events showed:
  - `odoo_primary` executed `odoo.rpc.search_read` (company resolution)
  - `odoo_primary` executed `odoo.finance.shopify.monthly_roi` (`rows=22`)

## Status

- `pytest` is now persistent on host and in backend Docker images.
- Shopify connector flow is runtime-ready and actively executes the intended helper.
- Remaining quality caveat (expected): attribution confidence still depends on ledger tagging quality; this is surfaced via attribution notes in output.

## Exact verify commands

```bash
python3 -m pytest --version
docker exec ghoststack-rag-control-api-1 python -m pytest --version
docker exec ghoststack-rag-agent-ingress-1 python -m pytest --version
docker exec ghoststack-rag-workflow-runtime-1 python -m pytest --version
```
