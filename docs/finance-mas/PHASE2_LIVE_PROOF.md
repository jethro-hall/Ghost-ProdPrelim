# Phase 2.6 — Live proof (operator prompts)

**Product wiring:** On success, `run_odoo_mas_pipeline` returns a `phase2` object (`resolved_metrics`, optional `variance_pack` when two or more entity rows) and appends a **Finance intelligence (Phase 2 — deterministic)** block to `markdown`. The Finance agent MAS tool payload includes the full `response`; `execution_truth.phase2` is set to `true` when `phase2` is present.

Run these in the product **after** the Finance Agent chat path and MAS integration are confirmed working. Each prompt should be satisfied only from **metric packs, variance, anomaly, and forecast** outputs (no raw-ledger primary answers). Paste sanitized results here when each check passes.

## TASK-260 — March 2026 cross-entity comparison

**Prompt:**  
`Compare revenue, COGS, gross profit, gross margin and marketing cost across Retail, Burleigh and Brisbane for March 2026.`

**Record:** short answer summary + pointer to `VariancePack` / resolved metrics JSON.

## TASK-261 — Centralized marketing ROAS

**Prompt:**  
`Show ROAS for Brisbane and Burleigh in March 2026 using centralized marketing.`

**Record:** `centralized_roas` for each branch (entity revenue / Retail marketing for the same period). Must match `metric_definitions.json` `roas.mode` = `central_marketing_vs_entity_revenue`.

**2026-04-26 human test (ghost_chatui / Finance Agent): initial FAIL, corrected at API layer**

- Prompt submitted in `ghost_chatui` using **Finance Agent**.
- The first rendered answer was **not finance-safe**:
  - It divided each entity revenue by the full centralized marketing pool.
  - It duplicated the full marketing pool per entity.
  - It showed stale ROAS caveats after computing ROAS.
  - It rendered empty monthly P&L rows.
  - It rendered net profit even though net semantics are blocked.
  - It allowed non-Odoo citations in an Odoo-only answer.

Corrected behavior verified after patch/rebuild via `/api/odoo/mas/answer`:

- Source plan includes branch P&L for Brisbane/Burleigh plus Retail marketing evidence.
- Allocation method defaults to `revenue_weighted`.
- Centralized marketing pool: `64906.18`.
- Allocated marketing:
  - Brisbane: `22321.211172401006`
  - Burleigh: `42584.968827599`
- Revenue ROAS:
  - Brisbane: `6.594846438351478`
  - Burleigh: `6.594846438351478`
- GP ROAS:
  - Brisbane: `2.4734061056804797`
  - Burleigh: `2.1552987480529957`
- API checks:
  - no `Supporting Ledger Evidence` when ledger evidence was not requested
  - no `Net Profit` / `net profit`
  - no broken `Monthly Breakdown`
  - includes `revenue roas`
  - includes `gp roas`
  - no `SriLanka.pdf` / `Export_2026-03-25_155400.xlsx` in markdown

## TASK-262 — Anomaly proof

**Prompt:**  
`Find anomalies in COGS and gross margin across the three entities for Jan to Mar 2026.`

**Record:** `AnomalyPack` flags and rule ids hit (e.g. `cogs_mom_up`, `gross_margin_pp_drop`).

## TASK-263 — Forecast proof

**Prompt:**  
`Forecast revenue, COGS and GP for the next three months using trailing 3-month average.`

**Record:** `ForecastPack` with method `trailing_average_3m` and caveats if there are fewer than 3 valid periods in history.

---

**Verify (automated layer):**

```bash
cd /var/llamaindex/ghoststack-rag/backend && PYTHONPATH=src python3.12 -m pytest -q tests/test_odoo_mas_phase2_intelligence.py tests/test_odoo_mas_phase2_core_metrics.py tests/test_odoo_mas_pipeline.py
```

Adjust `python3.12` to the interpreter used in your control-api image.
