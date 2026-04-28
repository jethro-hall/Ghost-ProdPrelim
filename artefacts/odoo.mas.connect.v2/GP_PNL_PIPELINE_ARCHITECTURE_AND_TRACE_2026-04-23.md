# GP P&L Pipeline Architecture + Request Trace

Date: 2026-04-23
Scope: Odoo MAS v2 Gross Profit (GP) / P&L pipeline

## 1) Architecture (current live path)

### A. Entry and orchestration

1. `POST /agent/chat` (Finance Agent) receives request.
2. Query planner emits a finance tool plan (`odoo.finance.*`) with payload/date hints.
3. In agent-ingress, Finance Agent finance plans are routed to MAS v2 execution path.
4. MAS returns structured payload + markdown summary; agent response is composed with tool evidence.

### B. MAS v2 core stages

1. **Intent Router** (`odoo_mas/router.py`)
   - Detects metric intent (`gross_profit`, etc.), business unit aliases, and period scope.
   - Current limitation: period parser is heuristic (e.g., "march", "last month", else default 30-day window).
2. **Source Planner** (`odoo_mas/planner.py`)
   - Builds source requests; GP/P&L uses `profit_and_loss`.
3. **Extractor** (`odoo_mas/extractors.py`)
   - Calls private/internal Odoo connector path (not publicly exposed to UI/LLM catalog).
4. **Normalizer** (`odoo_mas/normalizers.py`)
   - Normalizes to canonical lines: revenue, cogs, gross_profit, net_profit, ad_spend, roas.
5. **Assembler** (`odoo_mas/assembler.py`)
   - Builds `MetricPack`; derives GP if needed; computes confidence/gaps.
6. **Reasoner + Composer** (`odoo_mas/reasoner.py`, `odoo_mas/composer.py`)
   - Produces findings/caveats and board-style markdown.
7. **Return payload**
   - `success`, `intent`, `source_plan`, `metric_pack`, `reasoning`, `markdown`, `failures`.

### C. Truth and control model

- Legacy `odoo_primary` public catalog stays hidden (`/api/tools/catalog` is empty).
- Execution truth is still emitted in tool events, now with:
  - `execution_truth.evidence_source_mode = odoo_mas_v2`
- This preserves auditability while enforcing MAS as execution surface.

## 2) Live request tracked

Request tested:

> "Using Odoo only, show the gross profit (GP) for Brisbane from 1 July 2025 through 31 March 2026. Provide monthly values and total GP for the period. Do not estimate missing values."

Execution path observed:

- Endpoint: `/agent/chat`
- Agent: `Finance Agent`
- Tool event status: `executed`
- Operation label: `odoo.finance.margin.period_summary`
- Evidence mode: `odoo_mas_v2`

Observed output (before explicit-range parser fix):

- Returned period collapsed to March 2026 (single period), not Jul 2025 -> Mar 2026 monthly series.
- GP returned for Brisbane in March only (`A$55,209.42` in that run).
- Monthly Jul 2025 -> Mar 2026 series + total period GP not returned.

Observed output (after explicit-range parser fix):

- Intent period now correctly resolves to:
  - `date_from = 2025-07-01`
  - `date_to = 2026-04-01` (exclusive upper bound for requested 2026-03-31)
- Extract still returns a single aggregated row for the range:
  - Brisbane GP: `A$482,374.07`
- Monthly values are still not returned because source planning/normalization currently produce period-level P&L aggregation, not month-bucket rows.

## 3) Key issue found (must speak up)

The period interpretation layer does not currently honor explicit ISO range requests robustly in MAS routing.

- Example: request includes `2025-07-01` -> `2026-03-31`
- Router still resolved to short heuristic window / March period.

Impact:

- Users ask for a strict historical range, but the pipeline may respond with a different period.
- This is a correctness risk for board reporting.

## 4) Fit-for-purpose fix direction

Implement deterministic date-range extraction before heuristic fallback:

1. ✅ Parse explicit `YYYY-MM-DD` ranges first in `odoo_mas/router.py`.
2. ✅ If explicit range exists, lock `PeriodScope` exactly to requested bounds.
3. Add month-series mode for requests containing phrases like "monthly values", "month-by-month", "through to".
4. Update planner to request monthly buckets when month-series requested.
5. Update normalizer/assembler contracts to accept and preserve month-bucket rows.
6. Add regression tests:
   - explicit range honored
   - monthly series returned with total GP aggregation
   - no fallback to heuristic period when explicit dates present

## 5) Current acceptance status for this request

- "Show GP for Brisbane from 1st July 2025 through March 2026" = **PARTIAL / NOT YET PASS**
  - Explicit date range parsing: **PASS**
  - GP from Odoo for requested range: **PASS**
  - Requested full period monthly series + total: **NOT YET** (monthly bucketing still pending)

## 6) Verify commands

```bash
curl -sS https://ghoststack.rideai.com.au/api/tools/catalog

curl -sS -X POST https://ghoststack.rideai.com.au/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Using Odoo only, show the gross profit (GP) for Brisbane from 1 July 2025 through 31 March 2026. Provide monthly values and total GP for the period. Do not estimate missing values.","agent_id":"0488d744-c66c-4d0e-9a29-c68fa81ba84f","conversation_mode":"working_session","workflow_mode":"standard"}'

curl -sS -X POST https://ghoststack.rideai.com.au/api/odoo/mas/answer \
  -H 'Content-Type: application/json' \
  -d '{"message":"Using Odoo only, show gross profit for Ride Electric Brisbane from 2025-07-01 to 2026-03-31 with month-by-month values and total."}'
```

## 7) Repo hunt result ("how they do it") and copied pattern

Hunt result:

- Existing production pattern already lives in `backend/src/ghostdash_api/odoo_connector.py` under `_run_finance_margin_monthly_comparison`.
- It does not hardcode month tables. It dynamically:
  - resolves period window from request payload (`date_from`/`date_to`, optional `months`);
  - resolves company scope (`company_id`, `company_ids`, or `company_name_terms`);
  - reads monthly revenue and monthly COGS via `read_group` groupbys (`invoice_date:month`, `date:month`);
  - merges month buckets by `(company_id, month)`; computes `gp` and `gp_pct`;
  - returns both per-month rows and per-company totals.

Copied into MAS v2:

1. `odoo_mas/planner.py`
   - Added monthly-granularity planning and month-span calculation from explicit request range.
   - For monthly GP requests, planner now selects source key `profit_and_loss_monthly_margin_comparison`.
2. `odoo_mas/extractors.py`
   - Mapped new source key to existing helper operation `odoo.finance.margin.monthly_comparison` (same proven helper used elsewhere in repo).
3. `odoo_mas/normalizers.py`
   - Added normalization path for `profit_and_loss_monthly_margin_comparison`.
   - Preserves month buckets into report metadata (`monthly_rows`) while keeping company totals.
4. `odoo_mas/contracts.py`, `odoo_mas/assembler.py`, `odoo_mas/composer.py`
   - Extended metric contract with `monthly_rows`.
   - Composer now renders `## Monthly Breakdown` table (Business Unit, Month, Revenue, COGS, GP, GP%).
5. `backend/tests/test_odoo_mas_pipeline.py`
   - Added regression coverage for monthly granularity routing and planner source selection.
   - Added composer assertion for monthly breakdown output.

Validation:

- Targeted regression suite passes:
  - `pytest -q backend/tests/test_odoo_mas_pipeline.py backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_control_api_odoo_mas.py backend/tests/test_tools_api.py`
  - Result: `67 passed`

## 8) Lightweight value transfer pass (targeted)

To keep MAS v2 lean while improving robustness, only two proven patterns were brought across:

1. Typo-tolerant normalization from workflow planning path
   - Added `_normalize_planning_text` equivalent in `odoo_mas/router.py`.
   - This improves intent/period parsing for noisy human input without adding new services or dependencies.
2. Fiscal-year token parsing (`FYxx`, `FYxx/yy`)
   - Added fiscal range extraction in `odoo_mas/router.py`.
   - MAS now resolves dynamic FY windows directly to `date_from`/`date_to`, preserving dynamic retrieval rules.

Why this is lightweight:

- No new endpoints, no new containers, no extra infra.
- Reused existing internal connector operations (did not duplicate extraction logic).
- Changes stay inside MAS router/tests only for this pass.

Additional validation for this pass:

- `pytest -q backend/tests/test_odoo_mas_pipeline.py`
  - Result: `7 passed`
- `pytest -q backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_control_api_odoo_mas.py backend/tests/test_tools_api.py`
  - Result: `62 passed`

Runtime verification:

- `POST /api/odoo/mas/answer` now returns:
  - `granularity = "monthly"` for typo-heavy monthly prompts
  - source selection: `profit_and_loss_monthly_margin_comparison`
  - populated `metric_pack.monthly_rows`
- `POST /agent/chat` (Finance Agent) tool event confirms:
  - `execution_truth.evidence_source_mode = "odoo_mas_v2"`
  - source plan uses monthly comparison helper with FY-derived dates.

Residual risk to address next (important):

- Final narrative answer in `/agent/chat` can still drift from tool evidence because downstream answer synthesis may prioritize other retrieved artifacts over tool payloads.
- Recommended targeted fix: enforce an "if tool_event.status=executed and evidence_source_mode=odoo_mas_v2, narrate directly from tool_event.payload.response.metric_pack/monthly_rows first" rule in answer composition.
