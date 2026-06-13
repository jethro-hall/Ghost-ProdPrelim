# EOFY Audit Package — GitHub Layout & Data Guide

This document describes the **audit package** pushed to GitHub after each n8n orchestrator run. It matches the folder structure you see under:

`https://github.com/jethro-hall/Claudeopus_Odoo_Audit/tree/main/snapshots/{snapshot_id}/`

Example snapshot (Ride Electric Wholesale, FY 2024–25):

`eofy_2025_wholesale_c2_2026-06-13T12-04-53-483Z`

> **Note:** Older runs used a hardcoded `brisbane` slug in the folder name even when another company was selected. New runs use `{company-slug}_c{company_id}` (e.g. `wholesale_c2`, `brisbane_c4`, `retail_c3`).

---

## 1. End-to-end flow — where data comes from

```text
Form (database + company + FY)
  → Build Snapshot Context          creates snapshot_id + snapshot_run_context.json
  → 01 Account Ledger               Odoo JSONL → local disk
  → 02 POS Retail                   Odoo JSONL → local disk
  → 03 Sanitise + Profile           raw JSONL → sanitised JSONL + readiness summary
  → 05 Master Data                  partners, products, stock, etc.
  → 04 GitHub Push                  metrics/manifests → GitHub snapshots/{id}/
  → 06 Raw GitHub Push              full raw JSONL → GitHub raw_data/{id}/
```

| Layer | Path on n8n server | Path on GitHub |
|-------|-------------------|----------------|
| **Working copy** | `/home/node/.n8n/odoo_forensic_exports/{snapshot_id}/` | — |
| **Audit package (safe for AI)** | same tree, subset of files | `snapshots/{snapshot_id}/` |
| **Raw byte-for-byte export** | `{snapshot_id}/**/raw/*.jsonl` | `raw_data/{snapshot_id}/` |

**Why two GitHub locations?**

- `snapshots/` — **summarised, sanitised, audit-ready** artefacts (metrics, anomalies, manifests, `audit_payload.json`). Safe to hand to Claude/Opus/MCP without live PII in labels.
- `raw_data/` — **full Odoo API output**, not sanitised. For row-level recomputation (trial balance, AP aging, bank rec). Private repo only.

---

## 2. GitHub folder breakdown (your screenshot)

What you see inside `snapshots/{snapshot_id}/`:

| Path on GitHub | Source stage | What it is | Why it exists |
|----------------|--------------|------------|---------------|
| `01_account_ledger/` | Stage 01 | Ledger metrics, anomalies, manifests | Prove FY ledger integrity; feed audit tests T01–T04, T10 |
| `02_pos_retail/` | Stage 02 | POS metrics, anomalies, manifests | POS vs ledger checks (T07); retail completeness |
| `03_sanitise_profile/` | Stage 03 | Readiness summary + stage pack | Confirms PII handling; lists models/rows profiled |
| `05_master_data/` | Stage 05 | Master data metrics, model counts | Partners, products, stock scope for cross-ref |
| `audit_payload.json` | Stage 04 (built) | **Single orientation file for auditors** | One JSON entry point: scope, stage summaries, test battery, MCP hints |
| `audit_package_manifest.json` | Stage 04 (built) | Push manifest: files uploaded, URLs, errors | Provenance and `opus_entry_point` link |

Stage **04** does not appear as a folder on GitHub — it is the **push/orchestration step** that assembles and uploads the above.

### 2.1 `01_account_ledger/`

| File | Description |
|------|-------------|
| `metric_pack.json` | Aggregates: total debit/credit, net balance, by-account, by-month, move counts |
| `anomaly_pack.json` | Rule-based flags (unposted moves, late writes, unreconciled lines, etc.) |
| `stage_pack.json` | Run metadata: snapshot_id, company, period, models exported, timing |
| `model_counts.json` | Row count per Odoo model |
| `api_errors.json` | Odoo API failures per model (empty = clean run) |

**Odoo models exported (typical):** `account.move`, `account.move.line`, `account.payment`, reconciles, bank statements, journals, accounts, taxes.

**Why:** EOFY audit must reconcile the general ledger before trusting POS or master data.

### 2.2 `02_pos_retail/`

| File | Description |
|------|-------------|
| `metric_pack.json` | POS totals, session counts, payment method breakdown |
| `anomaly_pack.json` | POS integrity issues (missing payments, session gaps) |
| `stage_pack.json` | Run metadata |
| `model_counts.json` | Rows per POS model |
| `api_errors.json` | Access or API errors |

**Odoo models:** `pos.order`, `pos.order.line`, `pos.payment`, `pos.session`, `pos.config`, etc.

**Why:** Retail revenue must tie to accounting journals for EOFY.

### 2.3 `03_sanitise_profile/`

| File | Description |
|------|-------------|
| `readiness_summary.json` | Status (`READY_FOR_CLAUDE` / `REVIEW_PII_REMAINS`), row counts, PII scan results |
| `stage_pack.json` | Sanitisation run metadata |

**Not pushed to GitHub:** the large `sanitised/*.jsonl` files and `claude_payload_all.jsonl` stay on the n8n disk (hundreds of MB). GitHub gets the **readiness proof**, not every sanitised row.

**Why:** Stage 03 proves data was PII-scrubbed before any LLM sees it; profile stats show coverage without uploading 500MB+ JSONL to GitHub.

### 2.4 `05_master_data/`

| File | Description |
|------|-------------|
| `metric_pack.json` | Cross-ref counts, stock totals, attachment breakdown |
| `anomaly_pack.json` | Master data quality flags |
| `stage_pack.json` | Run metadata |
| `model_counts.json` | Rows per master model |

**Odoo models:** `res.partner`, `product.product`, `stock.move`, `sale.order`, `purchase.order`, etc.

**Why:** Audit joins (partner ↔ move line ↔ product ↔ stock) need a consistent master slice for the same company and FY.

### 2.5 Root files

#### `audit_payload.json` — start here

Built by `lib/04_github_push.js`. Contains:

- `scope` — company, FY dates, timezone
- `readiness_summary` — sanitisation status
- `stages.stage_01_account_ledger` … `stage_05_master_data` — compressed metrics + anomaly samples
- `audit_test_battery` — tests T01–T12 an auditor should run
- `mcp_server` — how to query live data via MCP
- `raw_data` — pointer to `raw_data/{snapshot_id}/` on GitHub

**Why:** Opus/Claude gets one structured briefing instead of opening dozens of files.

#### `audit_package_manifest.json`

Lists every file pushed, GitHub URLs, push timestamp, and `opus_entry_point` (link to `audit_payload.json`).

---

## 3. Local-only data (not in GitHub snapshot folder)

On the n8n server, each snapshot also contains:

```text
{snapshot_id}/
├── snapshot_run_context.json       ← company, dates, odoo_db, created_at
├── 01_account_ledger/raw/*.jsonl   ← full Odoo ledger export
├── 02_pos_retail/raw/*.jsonl
├── 03_sanitise_profile/
│   ├── sanitised/{stage}/*.sanitised.jsonl
│   └── manifests/claude_payload_all.jsonl   ← all sanitised rows combined
├── 05_master_data/raw/*.jsonl
├── 04_github_push/manifests/       ← push logs
└── (optional) 04_claude_audit/
```

Raw JSONL is pushed separately to **`raw_data/{snapshot_id}/`** by Stage 06.

---

## 4. Sanitisation — what, how, and why

**Script:** `lib/03_sanitise_profile.js`  
**Rules:** `lib/sanitise-core.js`  
**Policy** (from `config/audit-scope.json`):

| Policy | Effect |
|--------|--------|
| `partner_names_hashed: true` | Partner/user/display labels → stable `ENTITY_{sha256-12}` |
| `bank_details_redacted: true` | Bank account numbers, payment refs → `[REDACTED_BANK]` |
| `descriptions_compacted: true` | Long `name` / `ref` / `description` → truncated + hash suffix |
| `text_compact_max_len: 64` | Max length before compaction |

**Why sanitise?**

- Odoo exports contain **real names, emails, bank refs, payment references**.
- Auditors and LLMs need **join keys and amounts**, not re-identifiable PII.
- Hashed entities stay **stable within a snapshot** (same input → same `ENTITY_` hash) so you can still group and join.

**How (streaming, since Jun 2026):**

1. Read each raw `.jsonl` line-by-line (never load whole file into memory).
2. Apply `sanitiseRecord()` per row.
3. Write `.sanitised.jsonl` and append to `claude_payload_all.jsonl` via stream writes.

---

## 5. Sanitisation examples — before and after

### 5.1 Partner / user labels (hashed)

Real row from snapshot `eofy_2025_brisbane_2026-06-13T12-04-53-483Z` — `account.move` (Wholesale invoice):

**Before (raw Odoo export)**

```json
{
  "id": 177485,
  "name": "WSINV-07059",
  "company_id_label": "Ride Electric Wholesale",
  "partner_id_label": "Ride Electric Retail",
  "commercial_partner_id_label": "Ride Electric Retail",
  "create_uid_label": "Jamie Bongiorno",
  "write_uid_label": "Chris Weatherall",
  "amount_total": 284.9,
  "state": "posted",
  "date": "2025-03-11"
}
```

**After (sanitised)**

```json
{
  "id": 177485,
  "name": "WSINV-07059",
  "company_id_label": "ENTITY_7bfbb8b93b5d",
  "partner_id_label": "ENTITY_8843600475c7",
  "commercial_partner_id_label": "ENTITY_8843600475c7",
  "create_uid_label": "ENTITY_c5be572e29ed",
  "write_uid_label": "ENTITY_e0b88b30b757",
  "amount_total": 284.9,
  "state": "posted",
  "date": "2025-03-11",
  "_sanitisation": {
    "model": "account.move",
    "personal_fields_redacted": 6,
    "bank_fields_redacted": 0,
    "compacted_text_fields": 0,
    "policy": "partner/user identities hashed; bank details redacted; descriptions compacted"
  }
}
```

**What changed:** `*_label` fields matching partner/user patterns are hashed. **Numeric IDs unchanged** (`partner_id_id: 359` still joins). **Financial fields unchanged** (`amount_total`, `date`, `state`).

---

### 5.2 Bank / payment reference (redacted)

**Before**

```json
{
  "id": 8821,
  "partner_id_label": "Acme Pty Ltd",
  "payment_ref": "TRF 4829103847291 JOHN SMITH",
  "acc_number": "123456789"
}
```

**After**

```json
{
  "id": 8821,
  "partner_id_label": "ENTITY_a1b2c3d4e5f6",
  "payment_ref": "[REDACTED_BANK]",
  "acc_number": "[REDACTED_BANK]",
  "_sanitisation": {
    "personal_fields_redacted": 1,
    "bank_fields_redacted": 2,
    "compacted_text_fields": 0
  }
}
```

**Why:** Bank numbers and payment references are not needed for aggregate audit tests but are high-risk PII.

---

### 5.3 Long description (compacted)

**Before** (`name` field, 180 characters)

```json
{
  "id": 440102,
  "name": "INV/2025/00441 - Customer return credit for e-bike battery replacement and labour adjustment per workshop job WO-2025-1847 including parts list and technician notes attached"
}
```

**After** (max 64 chars + hash tail)

```json
{
  "id": 440102,
  "name": "INV/2025/00441 - Customer return credit for e-b... [TEXT_TRUNCATED hash=9f3a2b1c8d4e len=180]",
  "_sanitisation": {
    "compacted_text_fields": 1
  }
}
```

**Why:** Keeps enough prefix for human/LLM context without shipping full narrative text.

---

### 5.4 What is NOT sanitised

These stay as-is on purpose:

- Record `id`, foreign key `*_id` numeric fields
- Amounts: `debit`, `credit`, `balance`, `amount_total`, `quantity`
- Dates: `date`, `invoice_date`, `create_date`
- States/enums: `posted`, `paid`, `out_invoice`
- Company scoping: `company_id_id`

---

## 6. Readiness summary (Stage 03 output)

Example from Wholesale FY24–25 run:

```json
{
  "summary": {
    "status": "REVIEW_PII_REMAINS",
    "total_rows": 311914,
    "models_profiled": 17,
    "pii_after_total": 8,
    "extraction_errors": 0
  }
}
```

| Status | Meaning |
|--------|---------|
| `READY_FOR_CLAUDE` | No PII patterns detected post-sanitise |
| `REVIEW_PII_REMAINS` | Residual `@` email or phone-like patterns in 8 rows — manual review |
| `REVIEW_EXTRACTION_GAPS` | Some models failed to export — audit incomplete |

---

## 7. Snapshot naming convention

Auto-generated by `Build Snapshot Context`:

```text
eofy_{FY-end-year}_{company-slug}_c{company_id}_{ISO-timestamp}
```

Examples:

| Company | snapshot_id prefix |
|---------|-------------------|
| Ride Electric Wholesale (id 2) | `eofy_2025_wholesale_c2_...` |
| Ride Electric Brisbane (id 4) | `eofy_2025_brisbane_c4_...` |
| Ride Electric Retail (id 3) | `eofy_2025_retail_c3_...` |
| EBD (id 1) | `eofy_2025_ebd_c1_...` |

`snapshot_run_context.json` at the snapshot root is the authoritative record of company, period, and `odoo_db`.

---

## 8. How to use this package as an auditor

1. Open **`audit_payload.json`** — orientation, scope, stage summaries, test battery.
2. Check **`03_sanitise_profile/readiness_summary.json`** — confirm export completeness and PII status.
3. Review **`01_account_ledger/anomaly_pack.json`** and **`02_pos_retail/anomaly_pack.json`** — starting hypotheses, not conclusions.
4. For row-level recomputation, use **`raw_data/{snapshot_id}/`** on GitHub (unsanitised JSONL).
5. For live queries, use MCP (`odoo_audit_init` → `odoo_query`) with the same `snapshot_id`.

---

## 9. Related repo files

| File | Role |
|------|------|
| `lib/04_github_push.js` | Builds `audit_payload.json` and pushes snapshot tree |
| `lib/06_raw_github_push.js` | Pushes raw JSONL to `raw_data/` |
| `lib/03_sanitise_profile.js` | Streaming sanitisation |
| `lib/sanitise-core.js` | Hash / redact / compact rules |
| `config/odoo-runtime.json` | Form companies and databases |
| `docs/OPUS-MCP-USAGE-GUIDE.md` | MCP auditor workflow |

---

*Generated for GhostDASH / Ride Electric EOFY forensic audit pipeline. Snapshot example: Wholesale, company_id=2, FY 2024-07-01 → 2025-06-30.*
