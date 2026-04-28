# Odoo report access discovery

Date: 2026-04-23
Executor: Cursor agent (live stack)
Status: complete

## Environment checked

- API entrypoint: `http://127.0.0.1/api/tools/odoo_primary/execute`
- Tool catalog: `odoo_primary` is `active=true`, `configured=true`, `read_only=true`
- Running services observed: `ghoststack-rag-control-api-1`, `ghoststack-rag-agent-ingress-1`, `ghoststack-rag-workflow-runtime-1`

## Confirmed production access pattern

Production calls are made through the Ghost control plane tool API, not a separate Node gateway:

1. `POST /api/tools/odoo_primary/execute`
2. JSON body with `{ "operation": "...", "payload": { ... } }`
3. Control-plane routes to Python connector (`backend/src/ghostdash_api/odoo_connector.py`)
4. Connector executes governed read-only Odoo JSON-RPC calls

## Report access method decisions

### 1) Profit and Loss

- Method used: named helper operation
- Operation: `odoo.finance.pnl.period_summary`
- Verdict: use in production

### 2) Balance Sheet

- Method used: governed fallback query path
- Operation: `odoo.rpc.search_read`
- Model: `account.move.line` with date/company scope
- Verdict: no dedicated balance-sheet helper currently exposed; use explicit fallback until a dedicated extractor is added

### 3) Cash Flow

- Method used: named fallback summary helper
- Operation: `odoo.finance.cash.runway_summary`
- Verdict: cashflow-style output is available through runway helper; no dedicated `cash_flow` report helper currently exposed

### 4) Aged Receivables

- Method used: named helper operation
- Operation: `odoo.finance.receivables.open`
- Verdict: use in production

### 5) Aged Payables

- Method used: named helper operation
- Operation: `odoo.finance.payables.open`
- Verdict: use in production

## Samples

Sanitized request/response examples are stored in:

- `discovery/sample-report-payloads/profit-and-loss.json`
- `discovery/sample-report-payloads/balance-sheet-fallback.json`
- `discovery/sample-report-payloads/cash-flow-fallback.json`
- `discovery/sample-report-payloads/aged-receivables.json`
- `discovery/sample-report-payloads/aged-payables.json`
