# Truth Drift Fix + Dynamic OPEX Ledger Plan

Date: 2026-04-23  
Scope: Finance Agent + Odoo MAS v2

## Why this change was required

1. Finance answers could drift from executed Odoo evidence when downstream narrative generation mixed other retrieval context.
2. Marketing/OPEX questions needed dynamic ledger retrieval (request-driven date/entity/terms), not static hardcoded payloads.

## What changed

### A) Truth drift risk hard-fix

- Enforced answer truth-lock when an executed tool event has `execution_truth.evidence_source_mode = odoo_mas_v2`.
- Final answer is rendered directly from MAS markdown + explicit execution-truth footer.
- Applied in shared answer normalization path so both `/agent/chat` and `/agent/chat/stream` inherit the same behavior.

### B) Dynamic OPEX ledger retrieval added

- Added MAS metric intent detection for:
  - `opex_total`
  - `marketing_costs`
- Added MAS source planning for dynamic OPEX query over `account.move.line` using `odoo.rpc.query_spec` + `read_group`.
- Query shape is dynamic by:
  - user period (`date_from`, `date_to`)
  - user business scope (`company_name_terms`)
  - user ledger terms (`ledger_terms`) extracted from request text.
- Marketing match logic uses proven repo semantic expansion (marketing -> advert/ad spend/channel terms) during normalization.

### C) Presentation and reasoning updates

- Added OPEX ledger rows into `MetricPack` and board markdown output under `## OPEX Ledger Search`.
- Preserves monthly/ledger context for auditability.
- Added immutable production policy defaults in config (`policy_config.json`) and enforced in metric assembly:
  - exclude merchant fees from marketing spend by default
  - exclude marketing wages from marketing spend by default
  - allow explicit override-only inclusion
  - board output uses absolute sign mode; internal accounting sign remains source-of-truth

## How it works (execution path)

1. User asks finance question.
2. Finance Agent tool plan is routed to MAS for:
   - `odoo.finance.*`
   - `odoo.rpc.query_spec`
   - `odoo.rpc.read_group`
3. MAS router extracts:
   - metrics
   - date range
   - business unit
   - ledger terms (for OPEX/marketing queries)
4. MAS planner builds dynamic `query_spec` over Odoo ledger.
5. Normalizer computes:
   - OPEX totals
   - marketing-cost totals from matched account rows
6. Composer produces markdown table(s).
7. Ingress locks final response to executed MAS markdown to prevent narrative drift.

## Validation

- Unit/integration regressions:
  - `pytest -q backend/tests/test_odoo_mas_pipeline.py`
  - `pytest -q backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_control_api_odoo_mas.py backend/tests/test_tools_api.py`
- Live verification:
  - `/api/odoo/mas/answer` returns dynamic OPEX ledger rows and marketing match flags.
  - `/agent/chat` returns MAS-grounded markdown with explicit `Execution Truth` block.

## Human confirmations received

Confirmed by user and now encoded as immutable defaults:

1. Merchant fees excluded from marketing spend by default.
2. Marketing wages excluded from marketing spend by default.
3. Output sign mode set to absolute for board rendering; internal accounting sign retained.

## Execution todo list (with final pause)

1. [x] Lock Finance Agent final narrative to executed MAS evidence.
2. [x] Add dynamic OPEX ledger retrieval through MAS (`odoo.rpc.query_spec` read_group).
3. [x] Add marketing-cost matching over ledger rows using proven repo semantics.
4. [x] Add regression tests and live verification.
5. [x] **WAITING FOR USER INPUT (last stop):** user confirmed account/vendor mapping and approved production policy defaults.
