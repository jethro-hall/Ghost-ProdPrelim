# Opus MCP Usage Guide — EOFY Forensic Audit v3

**Ride Electric Brisbane | FY 2024-07-01 → 2025-06-30 | company_id = 4**

This document is the canonical operating guide for Opus when using the EOFY MCP Forensic Audit v3 server. Read it in full before issuing any tool call. Every section contains constraints that affect the validity of audit conclusions.

---

## Section 0 — GitHub repo access

You have read access to the source repository for this entire audit system:

```
https://github.com/jethro-hall/ghoststack-rag
```

**Use the repo to self-orient before issuing MCP tool calls.** Key paths to read:

| Purpose | Repo path |
|---|---|
| Extraction pipeline scripts | `scripts/n8n-odoo-brisbane-eofy-audit/lib/` |
| Stage 01 account ledger exporter | `lib/01_account_ledger_exporter.js` _(embedded in n8n workflow)_ |
| Stage 02 POS retail exporter | `lib/02_pos_retail_exporter.js` |
| Stage 03 sanitise + profile | `lib/03_sanitise_profile.js`, `lib/sanitise-core.js`, `lib/profile-core.js` |
| Stage 04 audit payload prepare | `lib/04_claude_prepare.js` |
| Stage 04 GitHub audit package push | `lib/04_github_push.js` |
| MCP server (live Code node in n8n) | `lib/mcp_server.js` — **authoritative source; changes must be applied to both repo file AND the n8n DB Code node via the workflow history chain** |
| Stage 05 master data exporter | `lib/05_master_data_exporter.js` |
| MCP server (tool definitions) | `lib/mcp_server.js` |
| Audit config (scope, tests, join keys) | `lib/eofy-audit-config/` |
| n8n workflow definitions | `workflows/*.workflow.json` |
| This usage guide | `docs/OPUS-MCP-USAGE-GUIDE.md` |
| Full system README | `README.md` |

**What the repo tells you that the MCP cannot:**

- Exact fields extracted per model (read the exporter `fields` arrays)
- Domain filters applied at extraction time (read `buildDomain()` in each exporter)
- Sanitisation transforms applied (read `sanitise-core.js` — partner names are hashed to `ENTITY_*`, bank details redacted)
- Which models are guarded (extraction continues on access error) vs required (extraction halts)
- The full `audit-tests.json` test battery (use this to frame your audit analysis)
- The `join-keys.json` cross-reference map for building queries
- The `claude-audit-system-prompt.txt` system prompt (describes the expected output structure)
- The audit package committed by Stage 04 at `audit-exports/{snapshot_id}/` — **this is your primary starting point for each audit session**

**How to use repo access during an audit session:**

1. **Start here first:** read `audit-exports/{snapshot_id}/audit_package_manifest.json` — it lists every file pushed to the repo and gives the direct URL to `audit_payload.json` (the prepared sample data + readiness summary assembled for this snapshot).
2. Read `audit-exports/{snapshot_id}/audit_payload.json` to see the stratified sample records, readiness summary, extraction gaps, and audit test battery in one place — before touching any MCP tool.
3. Read stage packs (`01_account_ledger/stage_pack.json`, `02_pos_retail/stage_pack.json`, etc.) to understand row counts, field coverage, and any API errors per stage.
4. Before calling `odoo_audit_init`, read `mcp_server.js` → `toolAuditInit` to understand exactly what the init response contains.
5. Before calling `odoo_query` on a model, read the relevant exporter to confirm which fields are present and what sanitisation was applied.
6. If a query returns unexpected results, read `sanitise-core.js` to understand how values were transformed.
7. Use `audit-tests.json` to align your analysis with the pre-defined test battery rather than inventing ad-hoc tests.
8. Use `join-keys.json` to confirm cross-model join paths before writing aggregation queries.

> **Note:** The repo reflects the current deployed state. If you observe behaviour that contradicts the repo code, raise it as an anomaly — it may indicate a deployment drift or an undocumented override in the running container.

---

## Section 1 — MCP endpoint and authentication

The MCP server runs as an n8n webhook.

```
POST https://workflow.rideai.com.au/webhook/<webhook-path>
Content-Type: application/json
Authorization: Bearer <MCP_BEARER_TOKEN>
```

> **Security:** The bearer token must be retrieved from the credential vault or environment variable. It must never be committed to source control, included in audit outputs, or logged. If the token is not available in your session context, stop and request it through the authorised channel before proceeding.

Protocol: JSON-RPC 2.0 over HTTP POST.

---

## Section 2 — Canonical snapshot

Always pass `snapshot_id` explicitly in every tool call:

```
snapshot_id: "eofy_2025_brisbane_2026-06-09T23-11-45-949Z"
```

**Do not omit `snapshot_id`.** Eleven partial earlier runs exist in the same export root. The server's `latestSnapshot()` auto-detection can resolve to an incomplete snapshot. Explicit `snapshot_id` is the only safe call pattern.

Scope locked by this snapshot:

| Parameter | Value |
|---|---|
| Company | Ride Electric Brisbane |
| company_id | 4 |
| Period start | 2024-07-01 |
| Period end | 2025-06-30 |
| Timezone | Australia/Brisbane |
| Extract completed | 2026-06-09T23:13:06Z |

---

## Section 3 — Available models and confirmed row counts

Raw counts equal sanitised counts for every model in this snapshot. There is no row duplication. These are the authoritative figures.

**Stage 01 — Account Ledger**

| Model | Rows | Notes |
|---|---|---|
| account.move | 11,628 | Full FY 2024-07 → 2025-06, all move types |
| account.move.line | 37,523 | 12-month distribution confirmed, debit=credit verified |
| account.payment | 513 | See Section 5 — gap vs bank statement lines |
| account.partial.reconcile | 58,884 | Includes cross-FY links — count exceeding AML is expected |
| account.full.reconcile | 98,591 | Includes pre-FY closures — count exceeding AML is expected |
| account.bank.statement | 297 | |
| account.bank.statement.line | 1,643 | |
| account.account | 157 | |
| account.journal | 15 | |
| account.tax | 16 | |

**Stage 02 — POS Retail**

| Model | Rows | Notes |
|---|---|---|
| pos.order | 2,940 | Full FY, $1,161,607.48 total, 2024-07 → 2025-06 |
| pos.order.line | 5,981 | 2.03 avg lines/order — investigate |
| pos.payment | 3,182 | 1.08 payments/order |
| pos.session | 266 | |
| pos.config | 4 | |
| pos.payment.method | 9 | |
| pos.category | 110 | |

**Models entirely absent from Stages 01 + 02 — extraction gaps, not zero-record models:**

`res.partner`, `product.product`, `product.template`, `product.category`, `res.users`, `res.company`, `res.currency`, `account.tax.repartition.line`, `account.fiscal.position`, `account.payment.term`, `stock.move`, `stock.move.line`, `stock.valuation.layer`, `stock.picking`, `ir.attachment`, `mail.tracking.value`, `uom.uom`

Do not treat absence as evidence of zero activity. These models were not extracted in Stages 01 or 02. They are the target of **Stage 05** extraction. See Section 3D for Stage 05 details and field expectations.

**Stage 05 — Master Data, Product, Stock, Tax, and Audit Context (pending extraction)**

Stage 05 will populate all missing models above. Until Stage 05 completes and Stage 03 sanitisation is re-run for `export_stages: ["05_master_data"]`, the MCP cannot serve these models. Row counts will be updated in Section 3D after extraction.

| Model group | Models | Stage 05 status |
|---|---|---|
| Master data | res.company, res.currency, res.partner, res.users, product.product, product.template, product.category, uom.uom | Pending extraction |
| Stock / COGS | stock.move, stock.move.line, stock.valuation.layer, stock.picking, stock.location, stock.warehouse | Pending extraction |
| Source documents | sale.order, sale.order.line, purchase.order, purchase.order.line | Pending extraction |
| Tax / compliance | account.tax.repartition.line, account.fiscal.position, account.payment.term | Pending extraction |
| Audit trail | mail.message, mail.tracking.value, ir.attachment metadata | Pending extraction |
| Technical metadata (guarded) | ir.model, ir.model.fields, ir.module.module, ir.model.data, ir.property, ir.default, ir.rule, ir.model.access | Pending — access-denied models written to manifest, not fatal |

---

## Section 3A — Audit readiness status

The current dataset (Stages 01 + 02 + 03) supports ledger and POS structural audit only. It is **not** full forensic audit complete. Stage 05 extraction is planned to unblock the blocked areas. Until Stage 05 is extracted and sanitised, treat all "Blocked" items as hard data gaps — do not issue findings in those areas.

| Audit area | Status | Unblocked by Stage 05 | Reason |
|---|---|---|---|
| Ledger debit/credit balance | Ready | No (already ready) | account.move + account.move.line present |
| Monthly ledger trends | Ready | No (already ready) | Full FY AML coverage confirmed |
| POS order/payment integrity | Ready | No (already ready) | pos.order, pos.order.line, pos.payment present |
| Bank/payment reconciliation | Limited | Partially | Bank lines and payments present; partner context unblocked by Stage 05 |
| Partner/customer/supplier identity | Blocked — Stage 05 pending | Yes | res.partner not yet extracted |
| Product/category/margin audit | Blocked — Stage 05 pending | Yes | product.product, product.template, product.category not yet extracted |
| Stock/COGS valuation audit | Blocked — Stage 05 pending | Yes | stock.move, stock.move.line, stock.valuation.layer not yet extracted |
| User/audit-trail attribution | Blocked — Stage 05 pending | Yes | res.users and mail.tracking.value not yet extracted |
| Attachment/source-document evidence | Blocked — Stage 05 pending | Yes | ir.attachment metadata not yet extracted |
| GST/tax configuration audit | Limited — Stage 05 pending | Yes | account.tax present; tax repartition and fiscal position not yet extracted |
| Sale/purchase order linking | Blocked — Stage 05 pending | Yes | sale.order, purchase.order not yet extracted |
| Odoo config/access audit | Blocked — Stage 05 guarded | Partially | IR tables attempted with access-denied fallback written to manifest |

---

## Section 3B — Relationship map / join keys

These are the available joins within this snapshot. Opus must use these exact field names when constructing cross-model queries. If a field is absent from `odoo_schema`, treat the join as unavailable. Do not infer joins from field naming patterns.

**account.move.line joins**

```
account.move.line.move_id_id            -> account.move.id
account.move.line.account_id_id         -> account.account.id
account.move.line.journal_id_id         -> account.journal.id
account.move.line.partner_id_id         -> res.partner.id           [BLOCKED — res.partner absent]
account.move.line.product_id_id         -> product.product.id       [BLOCKED — product absent]
account.move.line.full_reconcile_id_id  -> account.full.reconcile.id
account.move.line.payment_id_id         -> account.payment.id
account.move.line.statement_line_id_id  -> account.bank.statement.line.id
```

**account.payment joins**

```
account.payment.move_id_id              -> account.move.id
```

**Reconciliation joins**

```
account.partial.reconcile.debit_move_id_id      -> account.move.line.id
account.partial.reconcile.credit_move_id_id     -> account.move.line.id
account.partial.reconcile.full_reconcile_id_id  -> account.full.reconcile.id
```

**Bank statement joins**

```
account.bank.statement.line.move_id_id          -> account.move.id
account.bank.statement.line.statement_id_id     -> account.bank.statement.id
```

**POS joins**

```
pos.order.account_move_id_id         -> account.move.id
pos.order.session_id_id              -> pos.session.id
pos.order.config_id_id               -> pos.config.id
pos.order.line.order_id_id           -> pos.order.id
pos.order.line.product_id_id         -> product.product.id          [BLOCKED — product absent]
pos.payment.pos_order_id_id          -> pos.order.id
pos.payment.payment_method_id_id     -> pos.payment.method.id
```

If a field is absent from `odoo_schema`, Opus must treat the join as unavailable and state it explicitly as a data limitation in any finding that depends on that join.

---

## Section 3C — Field expectations

Opus must call `odoo_schema(snapshot_id, model)` before querying any model. Do not assume fields exist. Field completeness varies — some fields were absent in Odoo or not selected during extraction. Always verify before filtering or projecting.

Critical field groups for each extracted model:

- **account.move** — `id`, `name`, `date`, `invoice_date`, `state`, `move_type`, `journal_id_id`, `journal_id_label`, `company_id`, `amount_total`, `amount_untaxed`, `amount_tax`, `payment_state`, `partner_id_id`, `currency_id`, `create_date`, `write_date`
- **account.move.line** — `id`, `move_id_id`, `move_id_label`, `account_id_id`, `account_id_label`, `journal_id_id`, `journal_id_label`, `date`, `debit`, `credit`, `balance`, `reconciled`, `full_reconcile_id_id`, `payment_id_id`, `statement_line_id_id`, `write_date`
- **account.payment** — `id`, `date`, `amount`, `payment_type`, `partner_type`, `state`, `move_id_id`, `currency_id`, `create_date`, `write_date`
- **account.partial.reconcile** — `id`, `debit_move_id_id`, `credit_move_id_id`, `full_reconcile_id_id`, `amount`, `max_date`, `create_date`
- **account.full.reconcile** — `id`, `reconciled_line_ids`, `partial_reconcile_ids`, `create_date`
- **account.bank.statement** — `id`, `date`, `balance_start`, `balance_end_real`, `journal_id_id`, `create_date`
- **account.bank.statement.line** — `id`, `date`, `amount`, `payment_ref`, `move_id_id`, `statement_id_id`, `create_date`
- **account.account** — `id`, `code`, `name`, `account_type`, `reconcile`, `deprecated`, `company_id`
- **account.journal** — `id`, `name`, `code`, `type`, `company_id`, `default_account_id_id`
- **account.tax** — `id`, `name`, `type_tax_use`, `tax_scope`, `amount_type`, `amount`, `active`
- **pos.order** — `id`, `name`, `date_order`, `session_id_id`, `config_id_id`, `state`, `amount_total`, `amount_tax`, `amount_paid`, `amount_return`, `account_move_id_id`, `create_date`, `write_date`
- **pos.order.line** — `id`, `order_id_id`, `product_id_id`, `qty`, `price_unit`, `discount`, `price_subtotal`, `price_subtotal_incl`, `create_date`
- **pos.payment** — `id`, `pos_order_id_id`, `payment_method_id_id`, `amount`, `payment_date`, `session_id_id`, `create_date`
- **pos.session** — `id`, `name`, `config_id_id`, `state`, `start_at`, `stop_at`, `create_date`
- **pos.config** — `id`, `name`, `company_id`, `active`
- **pos.payment.method** — `id`, `name`, `is_cash_count`, `company_id`

---

## Section 3D — Stage 05 model details, field expectations, and join keys

This section pre-documents Stage 05 models. Update row counts in the tables below after Stage 05 extraction and sanitisation. Join keys are defined in advance so queries can be constructed immediately once data is available.

**Row counts (populate after Stage 05 extraction)**

| Model | Expected domain | Rows after extraction |
|---|---|---|
| res.company | id = 4 | _(populate)_ |
| res.currency | no filter | _(populate)_ |
| res.partner | company_id in [4,false] + all referenced partner IDs | _(populate)_ |
| res.users | company_id in [4,false] + all referenced user IDs | _(populate)_ |
| product.product | referenced product IDs from AML, POS, stock | _(populate)_ |
| product.template | company_id in [4,false] + product_tmpl_id references | _(populate)_ |
| product.category | no filter | _(populate)_ |
| uom.uom | no filter | _(populate)_ |
| stock.move | company_id = 4, date within FY | _(populate)_ |
| stock.move.line | company_id = 4, date within FY | _(populate)_ |
| stock.valuation.layer | company_id = 4, create_date within FY | _(populate)_ |
| stock.picking | company_id = 4, date_done within FY | _(populate)_ |
| stock.location | company_id in [4,false] | _(populate)_ |
| stock.warehouse | company_id = 4 | _(populate)_ |
| sale.order | company_id = 4, date_order within FY | _(populate)_ |
| sale.order.line | order_id.company_id = 4, order within FY | _(populate)_ |
| purchase.order | company_id = 4, date_order within FY | _(populate)_ |
| purchase.order.line | order_id.company_id = 4, order within FY | _(populate)_ |
| account.tax.repartition.line | company_id = 4 | _(populate)_ |
| account.fiscal.position | company_id = 4 | _(populate)_ |
| account.payment.term | company_id = 4 or no company field | _(populate)_ |
| mail.message | res_model in audit-relevant models, FY | _(populate)_ |
| mail.tracking.value | linked to extracted mail.message ids | _(populate)_ |
| ir.attachment | metadata only (no binary), scoped to audit models | _(populate)_ |
| ir.model | guarded — may be access-denied | _(populate or "access-denied")_ |
| ir.model.fields | guarded | _(populate or "access-denied")_ |
| ir.module.module | guarded | _(populate or "access-denied")_ |

**Critical field expectations per Stage 05 model**

- **res.partner** — `id`, `name` (hashed post-sanitise → `ENTITY_*`), `company_id`, `commercial_partner_id`, `customer_rank`, `supplier_rank`, `is_company`, `vat`, `active`, `create_date`
- **product.product** — `id`, `name`, `categ_id_id`, `categ_id_label`, `product_tmpl_id_id`, `uom_id_id`, `default_code`, `active`, `type`, `standard_price`, `list_price`, `create_date`
- **product.template** — `id`, `name`, `categ_id_id`, `categ_id_label`, `company_id`, `type`, `standard_price`, `list_price`, `active`, `create_date`
- **product.category** — `id`, `name`, `parent_id_id`, `complete_name`, `property_account_income_categ_id_id`, `property_account_expense_categ_id_id`
- **stock.valuation.layer** — `id`, `product_id_id`, `product_id_label`, `quantity`, `unit_cost`, `value`, `stock_move_id_id`, `account_move_id_id`, `create_date`, `company_id`
- **mail.tracking.value** — `id`, `mail_message_id_id`, `field_id_id`, `field_desc`, `field_type`, `old_value_char`, `new_value_char`, `old_value_float`, `new_value_float`, `create_date`
- **ir.attachment** — `id`, `res_model`, `res_id`, `name`, `mimetype`, `file_size`, `create_date`, `write_date`, `create_uid_id` (exclude `datas`, `db_datas`, `raw`, `store_fname`)

**Stage 05 join keys**

```
res.partner.id                            <- account.move.line.partner_id_id
res.partner.id                            <- account.move.partner_id_id
res.partner.id                            <- account.payment.partner_id_id
res.partner.id                            <- pos.order.partner_id_id
res.partner.commercial_partner_id_id      <- res.partner.id (hierarchical)

product.product.id                        <- account.move.line.product_id_id
product.product.id                        <- pos.order.line.product_id_id
product.product.id                        <- stock.move.product_id_id
product.product.id                        <- stock.valuation.layer.product_id_id
product.product.product_tmpl_id_id        -> product.template.id
product.template.categ_id_id              -> product.category.id

stock.move.id                             <- stock.move.line.move_id_id
stock.move.id                             <- stock.valuation.layer.stock_move_id_id
stock.move.account_move_id_id             -> account.move.id
stock.picking.id                          <- stock.move.picking_id_id

sale.order.id                             <- sale.order.line.order_id_id
sale.order.name                           ~  account.move.invoice_origin (string reference)
purchase.order.id                         <- purchase.order.line.order_id_id
purchase.order.name                       ~  account.move.invoice_origin (string reference)

mail.message.id                           <- mail.tracking.value.mail_message_id_id
mail.message.res_id                       ~  record ID in the model named by mail.message.res_model
ir.attachment.res_id                      ~  record ID in the model named by ir.attachment.res_model

res.users.id                              <- account.move.create_uid
res.users.id                              <- account.move.write_uid
res.users.id                              <- mail.tracking.value (via mail.message.author_id_id)
```

**What Stage 05 unblocks**

After Stage 05 extraction and Stage 03 sanitisation:

- **Partner grouping** — debtor/creditor analysis by entity; AR/AP aging by partner
- **Product / category analysis** — POS margin by category, product concentration, top revenue products
- **Stock / COGS bridge** — link stock valuation layers to journal entries; verify COGS account routing
- **User attribution** — identify which user created/modified high-value records; support audit trail findings
- **Tax configuration audit** — verify GST repartition lines route to correct accounts
- **Attachment completeness** — verify source documents exist for invoices over a materiality threshold
- **Field-level change history** — detect post-period field edits on key financial records

Stage 05 data must pass through Stage 03 sanitisation before the MCP serves it. Raw Stage 05 files contain un-hashed partner names and unredacted contact details.

---

## Section 4 — Pre-MCP anomaly: `line_modified_after_period_end` is a confirmed false positive

The anomaly pack reports `line_modified_after_period_end: 37,523` — 100% of all `account.move.line` rows.

**Root cause (verified):** Every single `account.move.line` row has `write_date = "2026-05-18"` — exactly one date across all 37,523 records. This is a mass Odoo bulk operation (field recompute, balance recalculation, or schema migration executed on 2026-05-18). It is not post-period financial manipulation.

**Confirmed:** `date` (transaction date) correctly covers FY 2024-07 → 2025-06 across all 12 months.

**Opus must:**

- Ignore `write_date` on `account.move.line` as an anomaly signal for this entire dataset
- Use `date` (transaction date) for all period-based analysis
- Exclude `line_modified_after_period_end` from the anomaly pack entirely
- Note this false positive explicitly in the audit output under "Control Limitations"
- Not treat this as evidence of backdating or post-period adjustment under any circumstances

---

## Section 5 — Low row counts requiring active investigation

These are genuine data observations that Opus must investigate, not parsing errors or extraction failures.

**`account.payment: 513` vs `account.bank.statement.line: 1,643`**

Payment breakdown: 313 inbound customer + 115 outbound supplier + 85 inbound supplier + 2 outbound customer. Total payment value: $1,759,902.93. Bank statement lines: 1,643. The 3.2× gap means many bank lines are reconciled via journal entries rather than via `account.payment` records. Use `odoo_query(account.payment)` and trace via `account.partial.reconcile` to `account.bank.statement.line.move_id_id`.

**`pos.order.line: 5,981` for 2,940 orders (2.03 avg lines/order)**

Low for a bike shop selling accessories, parts, and services. Use `odoo_aggregate(pos.order.line, group_by=["order_id_id"], metrics=["count"])` to get the distribution of lines per order. Determine whether there are many single-line orders (indicating bundled pricing or service-only transactions).

**`pos.order.line` vs `pos.payment` (5,981 lines vs 3,182 payments)**

Use `odoo_query(pos.order, fields=["id","amount_total","amount_paid","state"])` to verify the three-way integrity: `amount_total` = `Σ pos.order.line.price_subtotal_incl`, `amount_paid` = `Σ pos.payment.amount`. Mismatch is a reportable finding.

**`account.partial.reconcile: 58,884` and `account.full.reconcile: 98,591` both exceed `account.move.line: 37,523`**

Expected behaviour: reconciliation records reference move lines from prior FY periods not included in this extract, and POS batch settlement creates many small reconcile records per session. Do not treat the count excess as an error. Use these tables only for tracing specific reconciliation chains.

---

## Section 6 — Raw data paths (pre-sanitisation layer)

The MCP server transparently serves sanitised data when stage 03 has run. For this snapshot, all data served by the MCP is from the sanitised layer.

**Container paths (read-only reference):**

```
/home/node/.n8n/odoo_forensic_exports/eofy_2025_brisbane_2026-06-09T23-11-45-949Z/
  01_account_ledger/
    raw/                          ← account.move.jsonl, account.move.line.jsonl, etc.
    metrics/                      ← account_ledger_metric_pack.json
    anomalies/                    ← account_ledger_anomaly_pack.json
    manifests/                    ← subworkflow_result.json, model_counts.json
  02_pos_retail/
    raw/                          ← pos.order.jsonl, pos.order.line.jsonl, etc.
    metrics/                      ← pos_retail_metric_pack.json
    anomalies/                    ← pos_retail_anomaly_pack.json
    manifests/                    ← subworkflow_result.json
  03_sanitise_profile/
    sanitised/
      01_account_ledger/          ← account.move.sanitised.jsonl (MCP serves this)
      02_pos_retail/              ← pos.order.sanitised.jsonl (MCP serves this)
      05_master_data/             ← (populated after Stage 05 + Stage 03 re-run)
    manifests/                    ← claude_readiness_summary.json, claude_payload_all.jsonl
  05_master_data/                 ← (created after Stage 05 extraction)
    raw/                          ← res.partner.jsonl, product.product.jsonl, stock.move.jsonl, etc.
    metrics/                      ← master_data_metric_pack.json
    anomalies/                    ← master_data_anomaly_pack.json
    manifests/                    ← subworkflow_result.json, model_counts.json, api_errors.json
```

> **Stage 05 sanitisation gate:** The MCP must not serve Stage 05 raw files to external Claude or Opus sessions. Stage 05 raw files at `05_master_data/raw/` contain un-hashed partner names and unredacted contact details. The sanitised layer at `03_sanitise_profile/sanitised/05_master_data/` is the only safe MCP serving path. Run Stage 03 with `export_stages: ["05_master_data"]` immediately after Stage 05 extraction completes.

**CSV bundle (recommended for full-population review):**

Path: `/home/node/.n8n/odoo_forensic_exports/audit_csv_bundles/latest_audit_bundle.zip`
Size: 1.32 MB — directly uploadable to claude.ai or Claude Desktop.

> The CSV bundle is suitable for full-population review of the currently extracted ledger and POS data. It is not a complete forensic dataset until master data, product, stock/COGS, users, tax metadata, attachment metadata, and audit-trail models are extracted. See Section 10.

Use `odoo_bundle_manifest` to read control totals. Use `odoo_bundle_csv` to page any model up to 10,000 rows per call.

**What sanitisation changes:**

| Data type | Transformation |
|---|---|
| Partner names, `write_uid_label`, partner text fields | Replaced with `ENTITY_{sha256[:12]}` |
| `payment_ref`, `acc_number`, bank detail fields | Replaced with `[REDACTED_BANK]` |
| Long text in `name`, `ref`, `description` (> 64 chars) | Truncated with hash suffix |
| Numeric fields, dates, IDs, amounts | Unchanged |

Numeric integrity is fully preserved through sanitisation. All financial analysis is valid on the sanitised layer.

To access raw `payment_ref` text or un-hashed partner names, direct filesystem access via an n8n Execute Command node is required. This must be explicitly authorised before use and is outside the MCP's scope.

---

## Section 7 — Recommended tool sequence

```
1. odoo_audit_init(snapshot_id)
   → Orientation: scope, all models, field index, pre-computed totals, anomaly leads
   → First call. Do not skip.

2. odoo_precomputed_metrics(snapshot_id)
   → Pre-built totals: debit/credit balance, monthly breakdown, reconciliation counts
   → Use to anchor analysis before reading any rows

3. odoo_precomputed_anomalies(snapshot_id)
   → Anomaly leads from extraction scripts
   → DISCARD line_modified_after_period_end entirely (confirmed false positive, Section 4)
   → Treat all other leads as starting hypotheses only, not conclusions

4. odoo_schema(snapshot_id, model)
   → Field types, completeness %, sample values
   → Required before querying each model. Do not assume fields exist.

5. odoo_aggregate(snapshot_id, model, group_by, metrics)
   → GROUP BY any field with COUNT/SUM/MIN/MAX
   → Zero raw row cost — use for pattern detection before pulling records

6. odoo_query(snapshot_id, model, filters, fields, limit)
   → Targeted filtered rows with server-side filtering
   → Always specify fields[] to limit payload
   → Always paginate with offset/limit for large models

7. odoo_journal_entry_detail(snapshot_id, move_ids)
   → Complete journal entry: header (account.move) + all lines + balance check
   → Use for drill-down on specific transactions

8. odoo_bundle_csv(model, offset, limit)
   → Full unfiltered CSV pages for any model
   → Use when complete unsampled data is required

9. odoo_bundle_manifest()
   → Full-population control totals (sum/min/max per numeric field)
   → Use to verify your analysis against the complete dataset
```

---

## Section 8 — Known extraction gaps and caveats

1. **No `res.partner` (Stages 01+02)** — partner labels are hashed `ENTITY_*` tokens. Grouping by `ENTITY_*` is valid; identity re-resolution is not possible until Stage 05 is extracted and sanitised.
2. **No product models (Stages 01+02)** — cannot link POS lines to product categories or COGS accounts. Stock/COGS tests fully blocked until Stage 05.
3. **No `res.users` (Stages 01+02)** — `create_uid_label` and `write_uid_label` are hashed. Audit trail attribution by user is not possible until Stage 05.
4. **`account.tax.amount` is non-additive** — the metric pack sums rate percentages, fixed amounts, and placeholder values together. Do not use any pre-computed `account.tax` aggregate as a financial total. Query individual tax records via `odoo_query` only.
5. **`account.partial.reconcile` (58,884) > `account.move.line` (37,523)** — expected: reconciliation records include links to pre-FY move lines not present in the AML export. Use for tracing specific reconciliation chains only; do not aggregate totals from this model.
6. **`account.bank.statement.line.payment_ref`** — redacted to `[REDACTED_BANK]` in the sanitised layer. The field exists but carries no usable content for matching. Raw access requires explicit authorisation.
7. **`account.move` sort order** — records are exported in Odoo ID order, not date order. Always apply a `date` filter or `sort_by: "date"` explicitly. Do not assume the last record is the most recent transaction.
8. **Missing fields confirmed during Stages 01+02 extraction:** `account.account.company_ids`, `account.move.line.commercial_partner_id`, `account.bank.statement.state`. These fields were requested but not available in this Odoo instance.
9. **Stage 05 raw files contain PII** — until Stage 03 is re-run with `export_stages: ["05_master_data"]`, the MCP must not serve `05_master_data/raw/` files to external Claude or Opus sessions. Only `03_sanitise_profile/sanitised/05_master_data/` is safe to serve.
10. **Guarded IR tables may be access-denied** — Stage 05 attempts IR technical models in read-only mode. Access failures are written to `05_master_data/manifests/api_errors.json` and the workflow continues. If absent from the MCP catalogue, treat as access-denied, not zero-record.

---

## Section 8A — Prohibited conclusions and unsafe inferences

Opus must not draw conclusions in the following categories from the current dataset:

- **Do not treat missing models as zero activity.** Absence of `res.partner`, `product.*`, `stock.*`, `res.users`, `ir.attachment`, or `mail.tracking.value` means those models were not extracted. It does not mean no such records exist in Odoo.
- **Do not infer customer or supplier identity from `ENTITY_*` tokens.** These are one-way hashes. Grouping by `ENTITY_*` is valid; claims about who a specific entity is are not.
- **Do not use `account.tax.amount` as a financial total.** The field mixes rate percentages and fixed amounts and is not an additive monetary field.
- **Do not use `account.move.line.write_date` as evidence of post-period manipulation for this snapshot.** All 37,523 AML rows share a single `write_date` of `2026-05-18` due to a mass Odoo bulk operation. See Section 4.
- **Do not conclude stock, COGS, or margin anomalies** until `product.product`, `product.category`, `stock.move`, `stock.move.line`, and `stock.valuation.layer` are extracted and available.
- **Do not conclude user misconduct or unauthorised access** without `res.users` and `mail.tracking.value` to establish user context and field-level change history.
- **Do not access or reference raw PII paths** (`/raw/` filesystem layer with un-hashed partner names or un-redacted payment references) unless explicitly authorised for this engagement.
- **Do not aggregate across companies.** Every query must scope to `company_id = 4` (Ride Electric Brisbane). The Odoo instance contains multiple companies. The export is filtered but Opus must verify `company_id` or `source_company_context` fields where relevant.

---

## Section 8B — Required completeness checks before beginning analysis

Opus must verify all of the following before proceeding with any audit finding:

1. `snapshot_id` in every tool response matches `eofy_2025_brisbane_2026-06-09T23-11-45-949Z`
2. Row counts from `odoo_audit_init` or `odoo_catalogue` match Section 3 exactly
3. `account.move.line` date coverage spans `2024-07` through `2025-06` (12 months)
4. `account.move` total debit equals total credit (confirmed: $13,770,100.50 each, net $0.00)
5. Unbalanced move count equals zero (confirmed: 0)
6. POS order total reconciles to $1,161,607.48
7. `odoo_audit_init` confirms `sanitised: true` on all model entries — MCP is serving the sanitised snapshot, not raw or an older partial snapshot
8. `line_modified_after_period_end` anomaly is excluded before any anomaly analysis begins

If any check fails, stop and report the discrepancy before proceeding.

---

## Section 9 — Key control totals (pre-verified)

These are the anchor figures for this snapshot. All analysis must reconcile against them.

**Ledger (from `account_ledger_metric_pack.json`):**

| Metric | Value |
|---|---|
| Total debit | $13,770,100.50 |
| Total credit | $13,770,100.50 |
| Net balance | $0.00 |
| Unbalanced moves | 0 |
| Unreconciled receivable lines | 14 |
| Unreconciled receivable balance | -$2,570.57 |
| Unreconciled payable lines | 184 |
| Unreconciled payable balance | -$564,967.23 |

**POS (raw computation from pos.order):**

| Metric | Value |
|---|---|
| Total orders | 2,940 |
| Total amount | $1,161,607.48 |

**`account.move` type breakdown:**

| Move type | Count |
|---|---|
| entry (journal) | 10,727 |
| out_invoice | 545 |
| in_invoice | 335 |
| in_refund | 13 |
| out_refund | 8 |

---

## Section 10 — Next extraction requirements

All Priority 1–3 models from this section are covered by the **Stage 05 extraction workflow** (`05-brisbane-eofy-master-data-sub.workflow.json`). The guarded IR models (formerly Priority 4) are also attempted by Stage 05 in access-guarded mode.

**Stage 05 deployment and execution steps are in the main README** under "Running Stage 05". After extraction: re-run Stage 03 with `export_stages: ["05_master_data"]`.

**Why each model group matters for Opus (ordered by audit impact)**

| Priority | Model group | Audit impact if absent |
|---|---|---|
| 1 | res.partner | Cannot resolve any ENTITY_* token; AR/AP aging fully blocked; partner-level findings impossible |
| 1 | product.product + product.template + product.category | Cannot analyse revenue by product or category; POS margin unknown; COGS unverifiable |
| 1 | res.users | Cannot attribute create/write actions to real users; misconduct findings blocked |
| 1 | res.company + res.currency | Cannot confirm Brisbane entity boundaries or detect multi-company cross-posting |
| 1 | uom.uom | Cannot verify unit quantities on POS lines or stock moves |
| 2 | stock.move + stock.move.line + stock.valuation.layer | COGS/inventory audit impossible; cannot bridge stock movements to journal entries |
| 2 | stock.picking + stock.location + stock.warehouse | Cannot trace delivery/receipt cycles; stock location routing unknown |
| 2 | sale.order + purchase.order | Cannot link invoices to source orders; invoice-to-order completeness untestable |
| 3 | account.tax.repartition.line + account.fiscal.position | GST base-vs-tax routing unverifiable; compliance testing blocked |
| 3 | account.payment.term | Aged debtors/creditors cannot be categorised by term; overdue analysis limited |
| 3 | mail.tracking.value | Post-period field edits undetectable; audit trail findings require this |
| 3 | ir.attachment metadata | Cannot confirm source documents exist for high-value invoices |
| 3 | mail.message | Provides context for tracking value events; communication audit trail |
| 4 (guarded) | ir.model + ir.model.fields | Odoo schema validation; customisation detection |
| 4 (guarded) | ir.module.module | Non-standard module identification; risk surface mapping |
| 4 (guarded) | ir.rule + ir.model.access | Security boundary audit; privilege escalation risk |
| 4 (guarded) | ir.property + ir.default | Default account mapping verification; data entry behaviour confirmation |

**After Stage 05 — remaining audit post-conditions**

Once Stage 05 is extracted and sanitised, the following checks become available:

1. Re-run `odoo_audit_init` — the model inventory and row counts will update automatically.
2. Use `odoo_aggregate(res.partner, group_by=["customer_rank","supplier_rank"])` to split entity universe.
3. Use `odoo_aggregate(pos.order.line, group_by=["product_id_id"], metrics=["sum:price_subtotal_incl"])` for product revenue ranking.
4. Cross-reference `stock.valuation.layer.account_move_id_id` → `account.move.id` to verify COGS journal entries exist for all stock layers.
5. Cross-reference `ir.attachment.res_id` + `ir.attachment.res_model = "account.move"` against `account.move` where `move_type in ["in_invoice","out_invoice"]` and `amount_total > materiality_threshold` to find invoices with no source document.
6. Cross-reference `mail.tracking.value` where `field_desc in ["Amount Total","Invoice Date","Partner","Account"]` and `create_date > "2025-06-30"` to find post-FY field edits on financial records.

**If Stage 05 cannot be run**

If Stage 05 extraction fails or is blocked by access, Opus must:
- Explicitly classify all partner, product, stock, user, tax-routing, and attachment findings as `confidence: insufficient_data`
- Not issue confirmed or probable findings in those areas
- Include the following sentence in the audit summary: "Material audit areas remain unassessable due to missing Stage 05 data. Final forensic conclusions are deferred pending extraction."

---

## Section 11 — Audit conclusion discipline

Every output from Opus must classify each item as one of:

| Classification | Definition |
|---|---|
| **Confirmed finding** | Directly evidenced by records in the current dataset with no missing model dependency |
| **Review candidate** | Supported by current data but requires additional extraction or human verification to confirm |
| **Extraction gap** | Cannot be assessed because one or more required models are absent |
| **Control limitation** | Analysis is constrained by sanitisation, missing fields, or dataset scope |

Every finding must include all of the following fields:

```
severity:          critical | high | medium | low
confidence:        confirmed | probable | indicative | insufficient_data
model:             the primary Odoo model involved
record_ids:        specific IDs from the dataset, or "not available"
date_range:        transaction date range covered by the finding
amount_impact:     financial impact in AUD, or "not quantifiable"
evidence:          tool name + specific field values + query used
why_it_matters:    EOFY impact and business risk
next_step:         specific action required (additional query, human review, extraction)
data_limitation:   any caveat from missing models, sanitisation, or dataset scope
```

No evidence means no finding. Do not issue findings based on inference, pattern assumption, or the absence of records in an incomplete dataset.
