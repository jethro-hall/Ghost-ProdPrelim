# ghoststack-rag

A `GhostDASH` RAG platform rebuilt around a LlamaIndex-native workflow runtime, a thin control API, a dedicated agent ingress boundary, `Postgres` for structured state, and `Qdrant` for retrieval.

## What Runs

- `caddy`: simple edge proxy for UI + API on port `80`
- `ui`: GhostDASH operator console (`Vite + React + TypeScript`)
- `control-api`: operator-facing control plane for uploads, connections, runtime-profile compatibility views, documents, vector stats, and ingest runs
- `agent-ingress`: `/agent/*` runtime boundary for chat and streaming answers
- `workflow-runtime`: LlamaIndex workflow service for ingestion and query planning
- `postgres`: system of record for documents, workbook structure, ingestion runs, runtime profiles, provider connections, conversations, and cache state
- `qdrant`: vector database for chunk retrieval

## Design Goals

- LlamaIndex-native workflow orchestration for ingestion and query planning
- Mixed-policy ingestion lanes:
  - local/private parsing for restricted corpora
  - `LlamaParse` for allowed rich documents
- Table-first XLSX ingestion with relational persistence plus retrieval artifacts
- Durable vector retrieval with `Qdrant`
- Operator-grade admin UX with GhostDASH

## Quick Start

1. Preserve your existing `.env` and update values as needed.
2. Start the stack:

```bash
docker compose up -d --build
```

3. Open the UI at `http://localhost/`
4. Open the control API docs at `http://localhost/api/docs`
5. Open the agent ingress docs at `http://localhost/agent/docs`
6. Check the API health endpoint at `http://localhost/health`

## Core API Surface

- `GET /api/connections`
- `POST /api/connections`
- `GET /api/runtime/defaults` (compatibility view over the default runtime profile)
- `POST /api/runtime/defaults` (updates the default runtime profile through the compatibility contract)
- `GET /api/agents`
- `POST /api/agents`
- `POST /api/upload`
- `POST /api/sync`
- `GET /api/tasks/{task_id}`
- `GET /api/documents`
- `GET /api/vector-stats`
- `POST /agent/chat`
- `POST /agent/chat/stream`

## Ingestion Model

The workflow runtime processes uploaded files in ordered steps:
- parse and structure
- generate retrieval artifacts
- embed
- index

Files can be routed to either:
- `local` lane for on-box parsing only
- `cloud` lane for `LlamaParse` when policy allows it

## Query Boundaries

- `/api/*` is for operator/control-plane actions only
- `/agent/*` is for runtime chat and agent requests only

## Docs

- `docs/ARCHITECTURE.md`
- `docs/ARCHITECTURE_V2.md`
- `docs/GHOSTDASH_UI_ARCHITECTURE.md`
- `docs/HANDOFF.md`
- `docs/MILESTONE1_RUNTIME_PROFILE_ARTIFACT.md`
- `docs/STRUCTURE_AWARE_CHUNKING_ARTIFACT.md`
- `docs/VECTORS_PAGE_STATS_FIX_ARTIFACT.md`
- `docs/APPROVED_WEB_DECISION_ARTIFACT.md`
- `docs/PHASE2_DOCS_REALIGNMENT_ARTIFACT.md`
- `docs/PHASE2_VERIFY_CLEAN_RELEASE_ARTIFACT.md`

---

## EOFY Forensic Audit — Ride Electric Brisbane

All audit tooling lives under `scripts/n8n-odoo-brisbane-eofy-audit/`. This system extracts Odoo financial data for FY 2024-07-01 to 2025-06-30 (company_id = 4, Brisbane only), sanitises it for AI use, and exposes it through an MCP server so Opus can run an independent forensic audit without raw PII access.

The complete operating guide for Opus is at:
`scripts/n8n-odoo-brisbane-eofy-audit/docs/OPUS-MCP-USAGE-GUIDE.md`

---

### Directory structure

```
scripts/n8n-odoo-brisbane-eofy-audit/
  config/
    audit-scope.json              ← company, FY, export paths, sanitisation policy
    audit-data-map.json           ← Odoo model field map
    audit-tests.json              ← completeness and integrity test catalogue
    model-registry.json           ← all 50+ extractable Odoo models with fields and domains
    join-keys.json                ← cross-model join field names
    claude-audit-system-prompt.txt ← system prompt for Opus audit sessions
  lib/
    02_pos_retail_exporter.js     ← Stage 02 POS extractor script
    03_sanitise_profile.js        ← Stage 03 PII sanitisation + profiling script
    04_claude_prepare.js          ← Stage 04 audit payload builder
    04_claude_call_api.js         ← Stage 04 Anthropic API caller
    04_claude_save_report.js      ← Stage 04 report writer
    05_master_data_exporter.js    ← Stage 05 master data + stock + audit trail extractor
    mcp_server.js                 ← EOFY MCP Forensic Audit v3 server (n8n Code node body)
    odoo-rpc.js                   ← Odoo JSON-RPC utility
    sanitise-core.js              ← PII sanitisation logic
    profile-core.js               ← JSONL profiling and readiness summary
  workflows/
    02-brisbane-eofy-pos-retail.workflow.json         ← Stage 02 POS subworkflow
    03-brisbane-eofy-sanitise-profile-sub.workflow.json ← Stage 03 sanitise subworkflow
    04-brisbane-eofy-claude-audit-sub.workflow.json   ← Stage 04 Claude audit subworkflow
    05-brisbane-eofy-master-data-sub.workflow.json    ← Stage 05 master data subworkflow
  docs/
    OPUS-MCP-USAGE-GUIDE.md       ← Complete Opus operating guide (read before any audit session)
    fix-execute-command-expression.md
```

---

### Extraction pipeline — stage overview

| Stage | Name | Extracts | Output path |
|---|---|---|---|
| 01 | Account Ledger | account.move, account.move.line, account.payment, account.partial/full.reconcile, account.bank.statement, account.bank.statement.line, account.account, account.journal, account.tax | `{snapshot}/01_account_ledger/raw/` |
| 02 | POS Retail | pos.order, pos.order.line, pos.payment, pos.session, pos.config, pos.payment.method, pos.category | `{snapshot}/02_pos_retail/raw/` |
| 03 | Sanitise + Profile | Reads stages 01/02 raw, writes sanitised JSONL + readiness summary + Claude payload | `{snapshot}/03_sanitise_profile/sanitised/` |
| 04 | Claude Audit | Prepares audit payload, calls Anthropic API, saves anomaly report | `{snapshot}/04_claude_audit/manifests/` |
| 05 | Master Data + Context | res.partner/users/company/currency, product.*, uom.uom, stock.*, sale/purchase orders, account.tax.repartition.line, fiscal.position, payment.term, mail.message, mail.tracking.value, ir.attachment metadata, IR tables (guarded) | `{snapshot}/05_master_data/raw/` |

Run stages in order: 01 → 02 → 03 → 04. Stage 05 can run in parallel with 04. Re-run Stage 03 with `export_stages: ["05_master_data"]` after Stage 05 completes.

---

### Canonical snapshot

The current audit-ready snapshot is:

```
eofy_2025_brisbane_2026-06-09T23-11-45-949Z
```

Located inside the n8n container at:
```
/home/node/.n8n/odoo_forensic_exports/eofy_2025_brisbane_2026-06-09T23-11-45-949Z/
```

Always pass `snapshot_id` explicitly to all MCP tool calls. Do not rely on auto-detection — 11 older partial snapshots exist in the same root.

---

### Running Stage 05

Stage 05 extracts all models missing from the initial audit-ready snapshot: master data, products, stock/COGS, source documents, tax configuration, audit trail, and attachment metadata.

**Step 1 — Deploy the script to the n8n container**

```bash
docker cp scripts/n8n-odoo-brisbane-eofy-audit/lib/05_master_data_exporter.js \
  ghoststack-rag-n8n-1:/home/node/.n8n/scripts/05_master_data_exporter.js
```

**Step 2 — Deploy the updated MCP server (adds 05_master_data stage)**

```bash
docker cp scripts/n8n-odoo-brisbane-eofy-audit/lib/mcp_server.js \
  ghoststack-rag-n8n-1:/home/node/.n8n/scripts/mcp_server.js
```

**Step 3 — Import the subworkflow into n8n**

In the n8n UI at `https://workflow.rideai.com.au`:
- Import `scripts/n8n-odoo-brisbane-eofy-audit/workflows/05-brisbane-eofy-master-data-sub.workflow.json`
- Activate the workflow

**Step 4 — Run the subworkflow**

Trigger the `05_SUB_MASTER_DATA` workflow with the following input JSON:

```json
{
  "snapshot_id": "eofy_2025_brisbane_2026-06-09T23-11-45-949Z",
  "target_company_id": 4,
  "target_company_name": "Ride Electric Brisbane",
  "company_context_ids": [4, 1, 2, 3, 5],
  "date_start": "2024-07-01",
  "date_end": "2025-06-30",
  "timezone": "Australia/Brisbane",
  "odoo_base_url": "https://odoo.rideelectric.com.au",
  "odoo_db": "<odoo-db-name>",
  "odoo_username": "<odoo-username>",
  "odoo_api_key_or_password": "<odoo-api-key>",
  "page_limit": 500,
  "output_root": "/home/node/.n8n/odoo_forensic_exports"
}
```

**Step 5 — Sanitise Stage 05 output before MCP use**

Immediately after Step 4 completes, run Stage 03 scoped to the new stage:

```json
{
  "snapshot_id": "eofy_2025_brisbane_2026-06-09T23-11-45-949Z",
  "export_stages": ["05_master_data"]
}
```

Stage 05 raw files contain un-hashed partner names and unreacted references. The MCP must not serve raw Stage 05 data to external Claude/Opus sessions.

---

### MCP server — what each tool needs to work effectively

The MCP server runs as an n8n webhook. Full tool reference is in `docs/OPUS-MCP-USAGE-GUIDE.md`. This section describes the minimum dataset each tool requires to return useful results.

#### `odoo_audit_init`

**What it does:** Returns a bootstrap package for starting an audit session — scope, all available models with row counts, field index for key models, pre-computed orientation totals, and anomaly leads.

**Minimum dataset to be effective:**
- Stages 01 + 02 extracted and sanitised (Stage 03 run)
- `account_ledger_metric_pack.json` present (written by Stage 01 exporter)
- `pos_retail_metric_pack.json` present (written by Stage 02 exporter)
- `claude_readiness_summary.json` present (written by Stage 03)
- At least `account.move`, `account.move.line`, `pos.order`, `pos.order.line`, `pos.payment` present

**Degraded if:**
- Stage 03 not run — serves raw data with PII
- Metric packs missing — orientation section returns null
- Only partial stages present — model inventory incomplete

---

#### `odoo_precomputed_metrics`

**What it does:** Returns pre-computed monthly debit/credit totals, trial balance by account, reconciliation counts, and POS totals from the metric packs written by the exporter scripts.

**Minimum dataset to be effective:**
- `account_ledger_metric_pack.json` for ledger metrics
- `pos_retail_metric_pack.json` for POS metrics
- Full FY coverage in `account.move.line` (all 12 months)

**Current confirmed values (canonical snapshot):**
- Total debit = $13,770,100.50
- Total credit = $13,770,100.50
- Net balance = $0.00
- Unbalanced moves = 0
- POS total = $1,161,607.48

**Degraded if:**
- Metric packs missing — falls back to raw computation from JSONL which may be slow
- Partial FY — monthly totals will show gaps

---

#### `odoo_precomputed_anomalies`

**What it does:** Returns pre-computed anomaly signals from the exporter anomaly packs.

**Minimum dataset to be effective:**
- `account_ledger_anomaly_pack.json` and `pos_retail_anomaly_pack.json`
- Full Stage 01 and Stage 02 extraction

**Critical known false positive — must exclude:**
- `line_modified_after_period_end` affects all 37,523 `account.move.line` rows
- Root cause: all rows have `write_date = 2026-05-18` (mass Odoo bulk operation)
- Opus must discard this anomaly type entirely for this snapshot

**Useful signals after Stage 05:**
- `master_data_anomaly_pack.json` adds: missing referenced partners, missing products, stock valuation gaps, attachment gaps on high-value invoices, post-FY tracking values

---

#### `odoo_query`

**What it does:** Server-side filtered query on any model with field projection and pagination. Primary raw data access tool.

**Minimum dataset per use case:**

| Query intent | Required models |
|---|---|
| Ledger entry drill-down | account.move + account.move.line |
| Payment tracing | account.payment + account.partial.reconcile |
| Bank reconciliation | account.bank.statement.line + account.move |
| POS order detail | pos.order + pos.order.line + pos.payment |
| Partner grouping | res.partner (Stage 05) |
| Product margin | product.product + product.template + pos.order.line (Stage 05) |
| Stock/COGS bridge | stock.valuation.layer + stock.move + account.move (Stage 05) |
| User attribution | res.users + mail.tracking.value (Stage 05) |
| Source document | sale.order + purchase.order (Stage 05) |

**Performance note:** Always pass `fields[]` with only required columns and `limit` for large models. `account.move.line` has 37,523 rows; `account.partial.reconcile` has 58,884. Unprojected full-table scans are slow and wasteful.

---

#### `odoo_aggregate`

**What it does:** Server-side GROUP BY with COUNT/SUM/MIN/MAX/AVG. Zero raw row cost — returns grouped totals only.

**Minimum dataset to be effective:**
- Any model with enough rows to make grouping meaningful
- Most useful on `account.move.line` (37,523 rows), `account.move` (11,628), `pos.order` (2,940), `account.partial.reconcile` (58,884)

**Key aggregation patterns:**
```
GROUP BY account_id_id, journal_id_id → trial balance by account and journal
GROUP BY move_type → invoice vs journal entry split
GROUP BY date[:7] → monthly trend (use sort_by: "min_date")
GROUP BY payment_type, partner_type → payment flow analysis
GROUP BY state → posted vs draft vs cancelled split
```

**After Stage 05:**
```
GROUP BY product_id_id → product revenue/cost concentration (pos.order.line)
GROUP BY categ_id_id (via product.template) → category-level analysis
GROUP BY res_model (ir.attachment) → attachment coverage by model
```

---

#### `odoo_schema`

**What it does:** Returns field types, completeness percentages, null rates, and sample values for any model. Required before querying any model for the first time.

**Minimum dataset:** Any extracted JSONL file. Call this before every model you haven't seen before. Missing fields found via `odoo_schema` before querying prevents wasted filter calls.

**Known missing fields in this snapshot:**
- `account.account.company_ids` — not available in this Odoo version
- `account.move.line.commercial_partner_id` — not available in this Odoo version
- `account.bank.statement.state` — not available in this Odoo version

---

#### `odoo_journal_entry_detail`

**What it does:** Returns a complete journal entry — header (`account.move`) + all debit/credit lines (`account.move.line`) + per-move balance check — for one or more move IDs.

**Minimum dataset:**
- `account.move` + `account.move.line` both present
- Most useful after `odoo_query` or `odoo_aggregate` identifies a suspicious `move_id`

**After Stage 05 adds:** partner context (`res.partner`), product context on line items (`product.product`)

---

#### `odoo_ledger_integrity`

**What it does:** Returns ledger balance check, unbalanced moves, monthly debit/credit, unreconciled receivable/payable. Uses pre-computed metric pack when available.

**Minimum dataset:** `account.move.line` (37,523 rows). Pre-computed pack (`account_ledger_metric_pack.json`) required for instant response; otherwise recomputes from JSONL.

**Current confirmed state:** Balanced (debit = credit = $13,770,100.50), 0 unbalanced moves, 14 unreconciled receivable lines (-$2,570.57), 184 unreconciled payable lines (-$564,967.23).

---

#### `odoo_pos_integrity`

**What it does:** Returns POS three-way check (order total vs line sum vs payment sum), missing account.move links, monthly POS totals. Uses pre-computed metric pack.

**Minimum dataset:** `pos.order`, `pos.order.line`, `pos.payment` all present. Pre-computed pack (`pos_retail_metric_pack.json`) required for instant response.

**After Stage 05 adds:** product context on `pos.order.line.product_id_id` → `product.product` → `product.template.categ_id_id` → `product.category`

---

#### `odoo_control_totals_with_sample`

**What it does:** Returns full-population control totals (sum/min/max over all rows) plus a stratified sample for independent analysis.

**Minimum dataset:** Any model with numeric fields. Most useful on:
- `account.move.line` — debit, credit, balance totals by month and account
- `pos.order` — amount_total, amount_paid by session and config
- `account.payment` — amount by payment_type and partner_type
- `stock.valuation.layer` — value by product (after Stage 05)

**Use to verify:** every Opus calculation must reconcile against the control totals. If your sum of debit from a filtered query does not match the corresponding slice of control totals, you have a filter error or a dataset gap.

---

#### `odoo_bundle_csv` / `odoo_bundle_manifest`

**What it does:** Reads pre-generated compact CSV audit bundles. Each bundle is a ZIP (~1.32 MB) containing one CSV per Odoo model with audit-critical fields.

**Minimum dataset:** CSV bundle at `/home/node/.n8n/odoo_forensic_exports/audit_csv_bundles/latest_audit_bundle.zip`

**Current bundle:** Generated from the canonical snapshot. Contains Stages 01 + 02 data only. Stage 05 data will be added to the next bundle after extraction.

**When to use:** When you need to upload the full dataset to claude.ai or another session. The bundle is 1.32 MB — directly uploadable. For MCP-based sessions, prefer `odoo_query` and `odoo_aggregate` for targeted access.

**When NOT to use:** As the only data access method. The bundle is a point-in-time extract; the MCP tools serve the live sanitised JSONL files with full pagination. Use the bundle for control total verification, not primary analysis.

---

#### `odoo_late_writes`

**What it does:** Returns records with `write_date >= threshold` (default 2025-07-01) for any model.

**Critical limitation on current snapshot:**
- `account.move.line` — ALL 37,523 rows have `write_date = 2026-05-18` (mass bulk operation). Do not use this tool on `account.move.line` for this snapshot without first confirming what the bulk operation was.
- Use `account.move.write_date` instead to identify moves genuinely modified after FY end. The move header is not affected by the same bulk write.

---

#### `odoo_unreconciled`

**What it does:** Returns unreconciled receivable and payable lines from `account.move.line`, totalled by account.

**Minimum dataset:** `account.move.line` with `reconciled` and `balance` fields present.

**Current confirmed values:**
- Unreconciled receivable: 14 lines, -$2,570.57
- Unreconciled payable: 184 lines, -$564,967.23

**After Stage 05 adds:** partner identity via `res.partner` join on `partner_id_id`

---

### Dataset expectations by audit area

This table shows the minimum complete dataset required before Opus can reach a reliable conclusion in each area. "Stage 05 required" means the current snapshot is insufficient.

| Audit area | Models required | Stage 05 required | Current state |
|---|---|---|---|
| Ledger balance (debit = credit) | account.move.line | No | Confirmed — $0 net |
| Monthly revenue trend | account.move + account.move.line | No | 12 months present |
| Journal entry integrity | account.move + account.move.line | No | 0 unbalanced moves |
| Bank reconciliation coverage | account.bank.statement.line + account.partial.reconcile | No | 1,643 lines, 58,884 reconcile records |
| Unreconciled AR/AP | account.move.line | No | 14 AR lines, 184 AP lines |
| Payment flow | account.payment + account.partial.reconcile | No | 513 payments, $1.76M |
| POS revenue total | pos.order | No | 2,940 orders, $1.16M |
| POS three-way integrity | pos.order + pos.order.line + pos.payment | No | Available — investigate 2.03 lines/order |
| Partner identity resolution | res.partner | Yes | Blocked — ENTITY_* tokens only |
| Product/category analysis | product.product + product.template + product.category | Yes | Blocked |
| COGS/margin analysis | product.* + stock.valuation.layer + account.move.line | Yes | Blocked |
| Stock movement audit | stock.move + stock.move.line + stock.picking | Yes | Blocked |
| User attribution | res.users + mail.tracking.value | Yes | Blocked |
| Post-period adjustments | account.move.write_date (not AML) | No | Investigate separately |
| Attachment/source documents | ir.attachment + account.move | Yes | Blocked |
| GST/tax routing | account.tax.repartition.line + account.move.line | Yes | Limited — tax rates present, routing absent |
| Field-level change history | mail.tracking.value + res.users | Yes | Blocked |
| Sale/purchase order linking | sale.order + purchase.order + account.move | Yes | Blocked |

---

### Deploying updated n8n scripts (general)

Any script in `lib/` that runs as an Execute Command node needs to be copied into the n8n container:

```bash
# Stage 02 POS exporter
docker cp scripts/n8n-odoo-brisbane-eofy-audit/lib/02_pos_retail_exporter.js \
  ghoststack-rag-n8n-1:/home/node/.n8n/scripts/02_pos_retail_exporter.js

# Stage 03 sanitise
docker cp scripts/n8n-odoo-brisbane-eofy-audit/lib/03_sanitise_profile.js \
  ghoststack-rag-n8n-1:/home/node/.n8n/scripts/03_sanitise_profile.js

docker cp scripts/n8n-odoo-brisbane-eofy-audit/lib/sanitise-core.js \
  ghoststack-rag-n8n-1:/home/node/.n8n/scripts/sanitise-core.js

docker cp scripts/n8n-odoo-brisbane-eofy-audit/lib/profile-core.js \
  ghoststack-rag-n8n-1:/home/node/.n8n/scripts/profile-core.js

# Stage 04 Claude audit
docker cp scripts/n8n-odoo-brisbane-eofy-audit/lib/04_claude_prepare.js \
  ghoststack-rag-n8n-1:/home/node/.n8n/scripts/04_claude_prepare.js

docker cp scripts/n8n-odoo-brisbane-eofy-audit/lib/04_claude_call_api.js \
  ghoststack-rag-n8n-1:/home/node/.n8n/scripts/04_claude_call_api.js

# Stage 05 master data (new)
docker cp scripts/n8n-odoo-brisbane-eofy-audit/lib/05_master_data_exporter.js \
  ghoststack-rag-n8n-1:/home/node/.n8n/scripts/05_master_data_exporter.js

# MCP server (update whenever mcp_server.js changes)
docker cp scripts/n8n-odoo-brisbane-eofy-audit/lib/mcp_server.js \
  ghoststack-rag-n8n-1:/home/node/.n8n/scripts/mcp_server.js
```

Config files used by the scripts (inside container at `eofy-audit-config/`):

```bash
docker exec ghoststack-rag-n8n-1 mkdir -p /home/node/.n8n/scripts/eofy-audit-config

for f in audit-scope.json audit-tests.json join-keys.json claude-audit-system-prompt.txt; do
  docker cp scripts/n8n-odoo-brisbane-eofy-audit/config/$f \
    ghoststack-rag-n8n-1:/home/node/.n8n/scripts/eofy-audit-config/$f
done
```

---

### Key constraints for Opus audit sessions

1. Always pass `snapshot_id: "eofy_2025_brisbane_2026-06-09T23-11-45-949Z"` explicitly.
2. Always call `odoo_audit_init` first — one call orients the session.
3. Call `odoo_schema` before querying any model for the first time.
4. Use `odoo_aggregate` before `odoo_query` — aggregate first to understand distribution, then query targeted rows.
5. Discard `line_modified_after_period_end` anomaly entirely — confirmed false positive (all 37,523 AML rows share `write_date = 2026-05-18`).
6. Do not treat absent models as zero activity — absent means not extracted.
7. Do not use `account.tax.amount` as a financial total — non-additive field.
8. Stage 05 must be sanitised before MCP use — raw files contain un-hashed partner names.
9. Every finding must state: severity, confidence, models, record IDs, amount impact, evidence, and data limitation.
10. No evidence = no finding.

Full operating guide: `scripts/n8n-odoo-brisbane-eofy-audit/docs/OPUS-MCP-USAGE-GUIDE.md`
