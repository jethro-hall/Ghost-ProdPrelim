# TASKS.md — Cursor-Ready Execution Plan

**Version:** 1.0  
**Date:** 2026-04-23  
**Status:** Approved execution plan  
**Audience:** Cursor agents / implementation team

## Conventions

### Priority
- `P0` critical path
- `P1` high value
- `P2` useful but not blocking

### Status
- `TODO`
- `IN_PROGRESS`
- `BLOCKED`
- `DONE`

### Definition of done
A task is only done when:
1. code is committed
2. tests pass
3. acceptance criteria pass
4. docs are updated if behavior changed

---

# EPIC 0 — Live Odoo Capability Discovery

## TASK-001 — Confirm report access method
**Priority:** P0  
**Owner:** Backend integration  
**Depends on:** none  
**Status:** TODO

### Objective
Identify the real access pattern for Odoo accounting reports in the live instance.

### Steps
1. Inspect the existing Odoo connection implementation.
2. Determine whether reports are retrieved by:
   - direct JSON endpoint
   - report function call
   - rendered web endpoint
   - export endpoint
3. Capture one successful live request/response example for:
   - Profit and Loss
   - Balance Sheet
   - Cash Flow or fallback
   - Aged Receivables
   - Aged Payables
4. Store sanitized examples under `discovery/sample-report-payloads/`.

### Deliverables
- `discovery/odoo-report-access.md`
- `discovery/sample-report-payloads/*`

### Acceptance criteria
- At least 5 live example payloads exist.
- Each payload includes the request parameters used.
- The document explains which method should be used in production.

---

## TASK-002 — Confirm business-unit selector semantics
**Priority:** P0  
**Owner:** Backend integration  
**Depends on:** TASK-001  
**Status:** TODO

### Objective
Verify exactly how the selector values map to Odoo scope.

### Known visible values
- EBD
- Ride Electric Wholesale
- Ride Electric Retail
- Ride Electric Burleigh
- Ride Electric Brisbane

### Steps
1. Verify whether these are companies, branches, child companies, or custom reporting scopes.
2. Test live report retrieval for at least:
   - Ride Electric Burleigh
   - Ride Electric Brisbane
3. Record the exact parameter shape required to pass this scope.

### Deliverables
- `discovery/business-unit-dimension.md`

### Acceptance criteria
- Burleigh and Brisbane can be queried independently.
- Exact machine values are documented.
- No dimension inference remains in code comments or TODOs.

---

## TASK-003 — Confirm metric availability matrix
**Priority:** P0  
**Owner:** Finance logic  
**Depends on:** TASK-001, TASK-002  
**Status:** TODO

### Objective
Map each core metric to a confirmed source or a confirmed formula.

### Metrics
- revenue
- cogs
- gross_profit
- gross_margin_pct
- net_profit
- cash_balance
- ar_balance
- ap_balance
- tax_payable

### Steps
1. Test each metric against live reports.
2. Mark each metric as:
   - explicit
   - derived
   - unavailable
3. Record the line semantics used.

### Deliverables
- `discovery/metric-availability-matrix.md`

### Acceptance criteria
- Every listed metric has a source status.
- Every derived metric has a formula.
- Every unavailable metric is explicitly marked unsupported.

---

## TASK-004 — Confirm ROAS dependency path
**Priority:** P0  
**Owner:** Finance + marketing integration  
**Depends on:** TASK-003  
**Status:** TODO

### Objective
Determine whether ROAS is currently supportable.

### Steps
1. Determine where ad spend lives.
2. Test whether ad spend can be scoped by business unit.
3. Decide whether ROAS is:
   - supported from Odoo
   - supported from external source
   - unsupported for now

### Deliverables
- `discovery/roas-source-decision.md`

### Acceptance criteria
- ROAS support status is decided.
- If supported, the spend source is named and documented.
- If unsupported, system behavior is defined.

---

## TASK-005 — Define NET semantics
**Priority:** P0  
**Owner:** Finance logic / business owner  
**Depends on:** TASK-003  
**Status:** TODO

### Objective
Kill ambiguity around “NET”.

### Steps
1. Confirm business meaning of NET.
2. Record exact definition:
   - net profit before tax
   - net profit after tax
   - operating net
   - net sales
   - other
3. Update registry and prompts to use that meaning only.

### Deliverables
- `discovery/net-definition.md`

### Acceptance criteria
- NET has one approved definition.
- Metric registry updated accordingly.
- Router ambiguity handling updated if required.

---

# EPIC 1 — Registry Finalization

## TASK-006 — Finalize metric registry
**Priority:** P0  
**Owner:** Backend / config  
**Depends on:** TASK-003, TASK-004, TASK-005  
**Status:** TODO

### Objective
Turn provisional metric mappings into production configuration.

### Steps
1. Update `config/metric_registry.json`.
2. Add confirmed source semantics.
3. Add formulas for derived metrics.
4. Add failure modes and dependency rules.

### Acceptance criteria
- Every metric has `source_family`, `primary_source_key`, `derived`, and `failure_mode`.
- Registry validates as JSON.
- No placeholder semantics remain.

---

## TASK-007 — Finalize dimension registry
**Priority:** P0  
**Owner:** Backend / config  
**Depends on:** TASK-002  
**Status:** TODO

### Objective
Convert business-unit observations into stable configuration.

### Steps
1. Update `config/dimension_registry.json`.
2. Add aliases for user phrasing.
3. Preserve exact Odoo values.

### Acceptance criteria
- “Burleigh” resolves to `Ride Electric Burleigh`.
- “Brisbane” resolves to `Ride Electric Brisbane`.
- Unknown values fail closed.

---

## TASK-008 — Finalize source registry
**Priority:** P0  
**Owner:** Backend / config  
**Depends on:** TASK-001, TASK-003  
**Status:** TODO

### Objective
Bind source keys to real extractor implementations and real capabilities.

### Steps
1. Update `config/source_registry.json`.
2. Fill in real `extractor_key` values.
3. Document supported metrics and dimensions.
4. Add fallback paths.

### Acceptance criteria
- Every source has required params.
- Every source has an output contract.
- Unsupported dimensions are explicit.

---

## TASK-009 — Add presentation registry
**Priority:** P1  
**Owner:** Backend / config  
**Depends on:** none  
**Status:** TODO

### Objective
Move output modes into configuration.

### Steps
1. Create `config/presentation_registry.json`.
2. Add modes:
   - concise
   - analyst
   - board_ready
   - table_only
   - chart_pack
   - downloadable_report

### Acceptance criteria
- Composer can switch format using registry config.
- No hardcoded output mode strings outside config and tests.

---

# EPIC 2 — Extractor Implementation

## TASK-010 — Build Odoo client wrapper
**Priority:** P0  
**Owner:** Backend integration  
**Depends on:** TASK-001  
**Status:** TODO

### Objective
Create one thin authenticated wrapper for all Odoo report calls.

### Steps
1. Implement request builder.
2. Standardize auth/session handling.
3. Add retry and timeout policy.
4. Add structured logging.

### Deliverables
- `src/integrations/odoo/client.ts`

### Acceptance criteria
- Repeated live calls succeed.
- Auth/session logic is centralized.
- Timeouts and retries are configurable.

---

## TASK-011 — Implement Profit and Loss extractor
**Priority:** P0  
**Owner:** Backend integration  
**Depends on:** TASK-010, TASK-002  
**Status:** TODO

### Steps
1. Implement extractor.
2. Support:
   - date_from
   - date_to
   - business_unit
   - posted_only
   - comparison
3. Capture raw payload and metadata.

### Deliverables
- `src/extractors/odoo/profitAndLossExtractor.ts`

### Acceptance criteria
- March Burleigh pull works.
- March Brisbane pull works.
- Raw payload is saved in structured response shape.

---

## TASK-012 — Implement Balance Sheet extractor
**Priority:** P0  
**Owner:** Backend integration  
**Depends on:** TASK-010  
**Status:** TODO

### Deliverables
- `src/extractors/odoo/balanceSheetExtractor.ts`

### Acceptance criteria
- Date-scoped extraction works.
- Business-unit scope works if supported by Odoo; otherwise failure mode is explicit.

---

## TASK-013 — Implement Cash Flow extractor or fallback
**Priority:** P1  
**Owner:** Backend integration  
**Depends on:** TASK-010, TASK-001  
**Status:** TODO

### Deliverables
- `src/extractors/odoo/cashFlowExtractor.ts`

### Acceptance criteria
- Direct cash flow extraction works, or
- fallback behavior is implemented and tested.

---

## TASK-014 — Implement AR/AP extractors
**Priority:** P1  
**Owner:** Backend integration  
**Depends on:** TASK-010  
**Status:** TODO

### Deliverables
- `src/extractors/odoo/agedReceivablesExtractor.ts`
- `src/extractors/odoo/agedPayablesExtractor.ts`

### Acceptance criteria
- Both return raw payloads with consistent metadata envelope.

---

## TASK-015 — Implement operational journal extractor
**Priority:** P1  
**Owner:** Backend integration  
**Depends on:** TASK-010  
**Status:** TODO

### Objective
Support operational finance questions against configured journal entities.

### Deliverables
- `src/extractors/odoo/journalDashboardExtractor.ts`

### Acceptance criteria
- At least 3 configured journal entities can be pulled successfully.
- Unknown journal key fails with structured error.

---

## TASK-016 — Implement external marketing spend extractor
**Priority:** P1  
**Owner:** External integration  
**Depends on:** TASK-004  
**Status:** TODO

### Deliverables
- `src/extractors/external/marketingSpendExtractor.ts`

### Acceptance criteria
- If ROAS is supported, date + business_unit spend extraction works.
- If ROAS is unsupported, extractor returns structured unsupported response.

---

# EPIC 3 — Normalizer

## TASK-017 — Define normalized report contract
**Priority:** P0  
**Owner:** Backend / contracts  
**Depends on:** none  
**Status:** TODO

### Deliverables
- `src/contracts/NormalizedReport.ts`

### Acceptance criteria
- All report-based extractors can target one internal line model.

---

## TASK-018 — Build Odoo report normalizer
**Priority:** P0  
**Owner:** Backend / data processing  
**Depends on:** TASK-011  
**Status:** TODO

### Steps
1. Parse raw lines.
2. Convert strings to numbers.
3. Assign section codes.
4. Preserve hierarchy.
5. Strip UI-only fields.

### Deliverables
- `src/normalizers/odooReportNormalizer.ts`

### Acceptance criteria
- P&L raw payload becomes valid `NormalizedReport`.
- No formatted number strings remain in normalized line values.

---

## TASK-019 — Build scope normalizer
**Priority:** P0  
**Owner:** Backend / data processing  
**Depends on:** TASK-002  
**Status:** TODO

### Deliverables
- `src/normalizers/scopeNormalizer.ts`

### Acceptance criteria
- Every normalized report states exact business-unit scope in a consistent shape.

---

## TASK-020 — Build external spend normalizer
**Priority:** P1  
**Owner:** Backend / data processing  
**Depends on:** TASK-016  
**Status:** TODO

### Deliverables
- `src/normalizers/spendNormalizer.ts`

### Acceptance criteria
- Spend data is comparable row-for-row with accounting metrics.

---

## TASK-021 — Build quality flags
**Priority:** P1  
**Owner:** Backend / data processing  
**Depends on:** TASK-018, TASK-020  
**Status:** TODO

### Deliverables
- `src/normalizers/qualityFlags.ts`

### Acceptance criteria
- Missing lines, empty payloads, duplicate lines, and unsupported scopes are surfaced as flags.

---

# EPIC 4 — Assembler

## TASK-022 — Build metric resolver
**Priority:** P0  
**Owner:** Backend / finance logic  
**Depends on:** TASK-006, TASK-018  
**Status:** TODO

### Deliverables
- `src/assembler/metricResolver.ts`

### Acceptance criteria
- revenue, cogs, gross_profit, and net_profit resolve deterministically from registry rules.

---

## TASK-023 — Build formula engine
**Priority:** P0  
**Owner:** Backend / finance logic  
**Depends on:** TASK-022  
**Status:** TODO

### Deliverables
- `src/assembler/formulas.ts`

### Acceptance criteria
- GP, gross margin %, and ROAS are computed outside the LLM.
- Division-by-zero is handled safely.

---

## TASK-024 — Build comparison row builder
**Priority:** P0  
**Owner:** Backend / finance logic  
**Depends on:** TASK-022, TASK-023  
**Status:** TODO

### Deliverables
- `src/assembler/comparisonBuilder.ts`

### Acceptance criteria
- Burleigh vs Brisbane rows assemble into one consistent structure.

---

## TASK-025 — Build ranking logic
**Priority:** P1  
**Owner:** Backend / finance logic  
**Depends on:** TASK-024  
**Status:** TODO

### Deliverables
- `src/assembler/ranking.ts`

### Acceptance criteria
- Winner logic is deterministic.
- Mixed-signal scenarios produce explicit basis and caveat behavior.

---

## TASK-026 — Build metric pack builder
**Priority:** P0  
**Owner:** Backend / finance logic  
**Depends on:** TASK-024, TASK-025  
**Status:** TODO

### Deliverables
- `src/assembler/metricPackBuilder.ts`

### Acceptance criteria
- Final `MetricPack` validates against schema.
- Reasoner can operate without any raw source payload.

---

# EPIC 5 — Reasoning and Composition

## TASK-027 — Implement intent router
**Priority:** P0  
**Owner:** AI/backend  
**Depends on:** TASK-006, TASK-007, TASK-009  
**Status:** TODO

### Deliverables
- `src/agents/intentRouter.ts`

### Acceptance criteria
- User request becomes valid `IntentPayload`.
- Ambiguities are surfaced explicitly.
- Unknown business-unit text fails closed.

---

## TASK-028 — Implement source planner
**Priority:** P0  
**Owner:** AI/backend  
**Depends on:** TASK-008, TASK-027  
**Status:** TODO

### Deliverables
- `src/agents/sourcePlanner.ts`

### Acceptance criteria
- Intent becomes deterministic `SourcePlan`.
- Required external dependencies are included only when needed.

---

## TASK-029 — Implement finance reasoner
**Priority:** P0  
**Owner:** AI/backend  
**Depends on:** TASK-026  
**Status:** TODO

### Deliverables
- `src/agents/financeReasoner.ts`

### Acceptance criteria
- Reasoner uses only `MetricPack`.
- No direct Odoo access.
- Output states winner, basis, findings, and caveats.

---

## TASK-030 — Implement board composer
**Priority:** P0  
**Owner:** AI/backend  
**Depends on:** TASK-029  
**Status:** TODO

### Deliverables
- `src/agents/boardComposer.ts`

### Acceptance criteria
- Output includes:
  - executive summary
  - table
  - short explanation
  - caveats when needed
- No new calculations occur in composer.

---

## TASK-031 — Implement presentation mode router
**Priority:** P1  
**Owner:** AI/backend  
**Depends on:** TASK-009, TASK-030  
**Status:** TODO

### Deliverables
- `src/agents/presentationModeRouter.ts`

### Acceptance criteria
- Same metric pack can render as concise, analyst, board_ready, table_only, or downloadable_report.

---

# EPIC 6 — Tests

## TASK-032 — Add unit tests
**Priority:** P0  
**Owner:** QA / backend  
**Depends on:** TASK-023, TASK-025  
**Status:** TODO

### Deliverables
- `tests/unit/*`

### Acceptance criteria
- Formula engine coverage exists.
- Ranking coverage exists.
- Registry loading coverage exists.

---

## TASK-033 — Add integration tests
**Priority:** P0  
**Owner:** QA / backend  
**Depends on:** TASK-011 to TASK-016  
**Status:** TODO

### Deliverables
- `tests/integration/*`

### Acceptance criteria
- Live or controlled integration tests exist for all implemented extractors.

---

## TASK-034 — Add contract tests
**Priority:** P0  
**Owner:** QA / AI/backend  
**Depends on:** TASK-027, TASK-029, TASK-030  
**Status:** TODO

### Deliverables
- `tests/contracts/*`

### Acceptance criteria
- Router, reasoner, and composer outputs validate against expected schemas/contracts.

---

## TASK-035 — Add acceptance scenarios
**Priority:** P0  
**Owner:** QA / product  
**Depends on:** TASK-026, TASK-030  
**Status:** TODO

### Scenarios
1. Burleigh vs Brisbane for March with revenue/cogs/gp/net/roas
2. Cash position for Ride Electric Retail last month
3. Overdue receivables
4. ROAS unavailable because spend missing

### Deliverables
- `tests/acceptance/*`

### Acceptance criteria
- All 4 scenarios pass end-to-end.

---

## TASK-036 — Add golden output tests
**Priority:** P1  
**Owner:** QA / product  
**Depends on:** TASK-030  
**Status:** TODO

### Deliverables
- `tests/golden/*`

### Acceptance criteria
- Board-ready formatting remains stable across changes.

---

# EPIC 7 — Deployment

## TASK-037 — Package service
**Priority:** P0  
**Owner:** DevOps / backend  
**Depends on:** TASK-030  
**Status:** TODO

### Deliverables
- `Dockerfile`
- `.env.example`
- build scripts

### Acceptance criteria
- Service builds locally and in CI.

---

## TASK-038 — Build API layer
**Priority:** P0  
**Owner:** Backend  
**Depends on:** TASK-028, TASK-030  
**Status:** TODO

### Endpoints
- `/route`
- `/plan`
- `/extract`
- `/assemble`
- `/answer`
- `/report`

### Acceptance criteria
- Endpoints validate inputs and outputs against schemas.

---

## TASK-039 — Add caching
**Priority:** P1  
**Owner:** Backend  
**Depends on:** TASK-026  
**Status:** TODO

### Deliverables
- `src/cache/*`

### Acceptance criteria
- Report responses and metric packs are cached by parameter hash.

---

## TASK-040 — Add logging and tracing
**Priority:** P1  
**Owner:** Backend / DevOps  
**Depends on:** TASK-038  
**Status:** TODO

### Deliverables
- `src/observability/*`

### Acceptance criteria
- Each request logs request id, source plan, extractor timings, and token usage where applicable.

---

## TASK-041 — Security hardening
**Priority:** P0  
**Owner:** Backend / DevOps  
**Depends on:** TASK-038  
**Status:** TODO

### Acceptance criteria
- Odoo credentials are read-only.
- Raw user text never executes directly against extractors.
- Schema validation occurs at each boundary.

---

## TASK-042 — CI/CD and rollout
**Priority:** P1  
**Owner:** DevOps  
**Depends on:** TASK-037, TASK-038, TASK-041  
**Status:** TODO

### Acceptance criteria
- CI runs tests.
- Smoke tests run on deploy.
- Rollback path exists.

---

# EPIC 8 — Epic Charting / Graphs and Professional Document Output

## TASK-043 — Define chart spec contract
**Priority:** P1  
**Owner:** Frontend / reporting  
**Depends on:** TASK-026  
**Status:** TODO

### Deliverables
- `src/charts/chartSpec.ts`

### Acceptance criteria
- One internal chart model supports grouped bar, line, combo, waterfall, stacked bar, and KPI cards.

---

## TASK-044 — Build chart planner
**Priority:** P1  
**Owner:** Frontend / reporting  
**Depends on:** TASK-043  
**Status:** TODO

### Acceptance criteria
- Branch comparison requests map to grouped-bar or similar comparison-safe chart types.
- Trend requests map to line charts.

---

## TASK-045 — Build chart data transformer
**Priority:** P1  
**Owner:** Frontend / reporting  
**Depends on:** TASK-026, TASK-044  
**Status:** TODO

### Acceptance criteria
- `MetricPack` converts to renderable chart series without LLM involvement.

---

## TASK-046 — Implement in-chat chart rendering
**Priority:** P2  
**Owner:** Frontend  
**Depends on:** TASK-045  
**Status:** TODO

### Acceptance criteria
- Charts render cleanly in chat UI.
- Dense finance labels remain legible.

---

## TASK-047 — Build downloadable chart asset export
**Priority:** P2  
**Owner:** Frontend / reporting  
**Depends on:** TASK-045  
**Status:** TODO

### Acceptance criteria
- Charts export as PNG or SVG for report insertion.

---

## TASK-048 — Define document layout model
**Priority:** P1  
**Owner:** Reporting  
**Depends on:** TASK-030  
**Status:** TODO

### Deliverables
- `src/reporting/layout/documentModel.ts`
- `src/reporting/layout/reportTemplate.ts`

### Acceptance criteria
- Document structure supports title page, exec summary, KPI cards, tables, charts, caveats, appendix.

---

## TASK-049 — Build professional themes
**Priority:** P2  
**Owner:** Reporting / design  
**Depends on:** TASK-048  
**Status:** TODO

### Acceptance criteria
- At least 2 themes exist:
  - board pack
  - monthly branch comparison

---

## TASK-050 — Implement Apryse exporter
**Priority:** P2  
**Owner:** Reporting / backend  
**Depends on:** TASK-047, TASK-048  
**Status:** TODO

### Deliverables
- `src/reporting/apryse/apryseExporter.ts`

### Acceptance criteria
- One-click polished PDF export works from assembled board report content.

---

## TASK-051 — Build chat-to-download flow
**Priority:** P2  
**Owner:** Backend / frontend  
**Depends on:** TASK-050  
**Status:** TODO

### Acceptance criteria
- User can receive answer in chat and download a polished report from the same request context.

---

## TASK-052 — Visual QA
**Priority:** P2  
**Owner:** QA / design  
**Depends on:** TASK-046, TASK-050  
**Status:** TODO

### Acceptance criteria
- Charts, tables, spacing, and PDF page breaks are visually reviewed and signed off.

---

# Suggested Execution Order

## Phase A — Must do first
- TASK-001 to TASK-008

## Phase B — Core data path
- TASK-010 to TASK-026

## Phase C — AI layer
- TASK-027 to TASK-031

## Phase D — Hardening
- TASK-032 to TASK-042

## Phase E — Visual/reporting layer
- TASK-043 to TASK-052

---

# Release Gates

## Gate 1 — Discovery complete
Must pass:
- TASK-001 to TASK-005

## Gate 2 — Core finance path complete
Must pass:
- TASK-006 to TASK-026

## Gate 3 — Answer generation complete
Must pass:
- TASK-027 to TASK-031

## Gate 4 — Production readiness
Must pass:
- TASK-032 to TASK-042

## Gate 5 — Executive visual layer
Must pass:
- TASK-043 to TASK-052

---

# Immediate Next Actions for Cursor

1. Start with TASK-001 and TASK-002.
2. Do not implement extractors until discovery artifacts exist.
3. Fail closed on unknown business-unit mappings.
4. Treat ROAS as blocked until TASK-004 resolves it.
5. Treat NET as blocked until TASK-005 resolves it.
6. Only after TASK-006 to TASK-008 are done should agent logic be finalized.
