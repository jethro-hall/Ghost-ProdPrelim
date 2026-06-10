# Ride Electric Brisbane — Odoo EOFY Forensic Audit (n8n)

Importable n8n workflow JSON and config for **workflow.rideai.com.au**.

**Goal:** Extract live Odoo data for Ride Electric Brisbane (`company_id=4`, FY **2024-07-01 → 2025-06-30**), sanitise for Claude, profile completeness, and run a forensic anomaly scan to unblock EOFY submission.

## Directory layout

| Path | Purpose |
|------|---------|
| `config/audit-scope.json` | Company, FY dates, export paths, sanitisation defaults |
| `config/model-registry.json` | All Odoo models, fields, date/company filters (source of truth) |
| `config/join-keys.json` | Graph join keys for audit agent |
| `config/audit-tests.json` | Completeness + integrity test catalogue |
| `config/claude-audit-system-prompt.txt` | Claude system prompt for structured anomaly output |
| `lib/` | JavaScript helpers (embedded into workflow Code nodes by generator) |
| `workflows/*.workflow.json` | **Import these into n8n** |
| `generate_workflows.py` | Regenerate workflows after editing config/lib |

## Staged orchestrator (production)

| Stage | n8n workflow | Workflow ID |
|-------|----------------|-------------|
| Parent | `00_START_HERE_SINGLE_LEDGER_CLEAN` | `jYFaI5YUWM8KhwTY` |
| 01 Account ledger | `01_SUB_ACCOUNT_LEDGER` | `1HXbApqBqDVNVbCa` |
| 02 POS retail | `02_SUB_POS_RETAIL` | `ZPOS02Brisbane01` |
| 03 Sanitise + profile | `03_SUB_SANITISE_PROFILE` | `ZSAN03Brisbane01` |
| 04 Claude audit | `04_SUB_CLAUDE_AUDIT` | `ZCLA04Brisbane01` |

Parent chain: **01 Account Ledger** → **02 POS Retail** → **03 Sanitise Profile** → **04 Claude Audit** → **Return Core Result**.

Output paths per snapshot:

- `…/01_account_ledger/` — ledger export (stage 01)
- `…/02_pos_retail/` — POS export (stage 02)
- `…/03_sanitise_profile/` — sanitised JSONL, readiness summary, combined Claude payload
- `…/04_claude_audit/` — Claude anomaly report

Repo assets for stage 02:

- `lib/02_pos_retail_exporter.js` — deployed to `/home/node/.n8n/scripts/` in the n8n container
- `workflows/02-brisbane-eofy-pos-retail.workflow.json` — sub-workflow definition
- `deploy_pos_subworkflow.py` — re-apply stage 02 DB wiring if needed
- `deploy_stages_03_04.py` — deploy stage 03/04 scripts and wire parent orchestrator

**Refresh n8n** after deploy so the UI picks up new workflows/nodes.

## Quick start (n8n)

### 1. Prerequisites

- n8n at https://workflow.rideai.com.au
- **Odoo API credential** with read access to accounting models
- For POS/stock: credential user must have **Point of Sale/User** or **Inventory/User** (prior pilot failed `pos.order` with AccessError)
- **Anthropic API key** — set `ANTHROPIC_API_KEY=sk-ant-…` in repo `.env` and restart `n8n`, **or** update n8n credential **Anthropic account** (must start with `sk-ant-`)

### 2. Import workflows

In n8n: **Workflows → Import from file** (import each file in order):

1. `workflows/01-brisbane-eofy-odoo-extract.workflow.json`
2. `workflows/02-brisbane-eofy-sanitise-profile.workflow.json`
3. `workflows/03-brisbane-eofy-claude-audit.workflow.json`

After import, open workflow **01** and attach your Odoo credential to **Export all models to JSONL**.

Open workflow **03** and attach Anthropic credential to **Claude API — anomaly analysis**.

### 3. Run pipeline

**Workflow 01 — Extract**

- Execute manually.
- Output: `/home/node/.n8n/odoo_eofy_exports/{snapshot_id}__{group}__{model}__000000000.jsonl`
- Each model also writes a `.manifest.json` with `search_count`, row counts, and errors.

Copy the `snapshot_id` from the final node output (format: `eofy_brisbane_2026-06-10T…`).

**Workflow 02 — Sanitise + profile**

- Set `snapshot_id` in the **Set snapshot_id** node to match workflow 01.
- Output:
  - `/home/node/.n8n/odoo_eofy_exports_sanitised/{snapshot_id}/`
  - `/home/node/.n8n/odoo_eofy_reports/{snapshot_id}/claude_readiness_summary.json`
  - `/home/node/.n8n/odoo_eofy_reports/{snapshot_id}/claude_payload_all.jsonl`

**Workflow 03 — Claude audit**

- Set the same `snapshot_id`.
- Output: `claude_anomaly_report.json` with structured anomalies and `eofy_readiness.status`.

### 4. Download data from n8n

From the n8n host (or volume mount), copy:

- Raw exports: `odoo_eofy_exports/`
- Sanitised: `odoo_eofy_exports_sanitised/`
- Reports: `odoo_eofy_reports/`

Prior sample artefacts in this repo live under `CallData/odoo_eofy_*` for reference.

## Known fixes from prior pilot

| Issue | Fix in this package |
|-------|---------------------|
| `Invalid field 'commercial_partner_id' on account.move.line` | Removed from `account_move_line` fields in registry |
| `pos.order` AccessError | Documented — upgrade Odoo user groups; extraction records error in manifest |
| 500-row sample cap | Default is **full FY export** (`sample_limit: null`); set `sample_limit` in init node for pilots |
| Late `write_date` after FY | Surfaced in audit tests + Claude prompt |

## Regenerating workflows

After editing `config/` or `lib/`:

```bash
cd scripts/n8n-odoo-brisbane-eofy-audit
python3 generate_workflows.py
```

Re-import or paste updated Code node bodies into n8n.

## Audit agent handover caveats

Always state in audit outputs:

- Brisbane / `company_id=4` only — not group-wide unless expanded
- Missing model = extraction gap, not proof of no issue
- No financial conclusions without `account_move_line`
- No POS conclusions without `pos_order`, `pos_order_line`, `pos_payment`
- Sanitised `ENTITY_*` labels are for grouping, not re-identification

## Minimum dataset for full forensic audit

See `config/audit-tests.json` → `minimum_models_for_full_audit` (30 models). Any absence must be reported with impact.
