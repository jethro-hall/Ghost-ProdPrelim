# Odoo Finance MAS Build Document

**Version:** 2.0  
**Date:** 2026-04-23  
**Status:** Ready for Cursor build and deployment  
**Authoritative scope:** Odoo accounting report routing, extraction, normalization, metric assembly, reasoning, and board-ready presentation.

## 1. Executive Summary

Build a lean multi-agent system that converts natural-language finance questions into deterministic Odoo report calls, normalized evidence, derived metrics, and polished answers.

The system must prefer:
1. Existing Odoo accounting reports and report functions
2. Existing Odoo dashboard/journal views for operational finance questions
3. Deterministic metric assembly outside the LLM
4. LLM reasoning only after the data is normalized

This avoids:
- custom SQL for standard finance questions
- raw ledger reconstruction in prompts
- token-heavy reasoning over unstructured API blobs
- inconsistent answers for the same question

---

## 2. Observed Business-Dimension Model

From the supplied Odoo Profit and Loss screenshot, the company/entity selector currently includes:

- EBD
- Ride Electric Wholesale
- Ride Electric Retail
- Ride Electric Burleigh
- Ride Electric Brisbane

This means branch/business comparison is likely implemented at least partly through an Odoo company/entity selector rather than free-text branch inference.

**Implementation implication:** the routing layer must support a `business_unit` or `company_scope` dimension and map user terms like `Burleigh` and `Brisbane` to these exact Odoo values.

**Do not let Cursor infer this at runtime from user text alone.** Maintain an explicit dimension registry.

---

## 3. Architecture Goals

### Functional goals
- Route finance questions to the correct Odoo reports/functions
- Support multi-source questions spanning accounting + marketing + operational finance
- Assemble board-ready metric packs
- Support comparative questions across business units, companies, brands, locations, and channels
- Support narrative output modes: concise, analyst, board-ready, exception-focused

### Non-functional goals
- Minimize token usage
- Minimize LLM tool calls
- Maximize determinism
- Keep business logic outside prompts where possible
- Keep Odoo extraction read-only
- Keep agents narrow and composable

---

## 4. System Boundary

### In scope
- Odoo accounting reports
- Odoo journal/dashboard routing
- Metric normalization
- Derived metric calculation
- Comparative reasoning
- Board-ready composition

### Out of scope
- Direct SQL against Odoo accounting tables for standard report questions
- Write actions into Odoo
- OCR or screenshot parsing as a primary retrieval path
- Free-form agentic exploration of the Odoo model space during end-user queries

---

## 5. Core Principle

Use the following pipeline:

```text
user request
  -> intent router
  -> source planner
  -> odoo report extractor / external source extractors
  -> report normalizer
  -> metric assembler
  -> finance reasoner
  -> board composer
```

The LLM should not be the calculator.  
The LLM should not be the report engine.  
The LLM should not classify raw Odoo UI metadata on every call.

The LLM should:
- interpret user intent
- select sources
- reason over normalized evidence
- compose the answer

---

## 6. Agent Topology

### 6.1 `intent-router-agent`
**Purpose:** convert user language into a structured intent payload.

**Input**
- user query
- current date/time
- dimension registry
- metric registry
- source registry

**Output**
- intent
- requested metrics
- requested dimensions
- requested period
- presentation mode
- confidence
- ambiguity flags

**No direct Odoo access.**

---

### 6.2 `source-planner-agent`
**Purpose:** turn structured intent into an executable source plan.

**Input**
- intent payload
- metric registry
- dimension registry
- source registry

**Output**
- ordered source plan
- required Odoo reports
- required external sources
- derived metrics to compute
- fallback plan

**No financial narrative.**
**No direct user-facing prose.**

---

### 6.3 `odoo-report-extractor-agent`
**Purpose:** call Odoo report functions/endpoints with deterministic parameters.

**Allowed source types**
- Profit and Loss
- Balance Sheet
- Cash Flow
- Trial Balance
- General Ledger
- Partner Ledger
- Aged Receivables
- Aged Payables
- Tax Report
- Budget Report
- Journal Report
- journal dashboard / reconciliation views

**Output**
- raw Odoo payloads
- execution metadata
- filter metadata
- source timestamp

**No reasoning.**
**No prose.**

---

### 6.4 `external-spend-extractor-agent`
**Purpose:** fetch non-Odoo metrics such as ad spend if required for ROAS/marketing efficiency.

Use only when the source plan requires it.

**Examples**
- Meta spend
- Google Ads spend
- Shopify marketing spend
- external BI warehouse

If ad spend is posted cleanly and attributable inside Odoo, this agent can be skipped.

---

### 6.5 `report-normalizer-agent`
**Purpose:** transform raw report payloads into stable machine contracts.

**Responsibilities**
- convert formatted numbers to numeric values
- assign semantic section codes
- strip UI-specific noise
- flatten nested report lines
- preserve parent-child hierarchy
- retain dimensional filters

**Output**
- `NormalizedReport`

---

### 6.6 `metric-assembler-agent`
**Purpose:** combine normalized reports into a single metric pack.

**Responsibilities**
- compute derived metrics
- join branch/business-unit comparisons
- compute deltas and rankings
- flag missing dependencies
- flag low-confidence metrics

**Output**
- `MetricPack`

---

### 6.7 `finance-reasoner-agent`
**Purpose:** interpret the metric pack and answer the analytical question.

**Responsibilities**
- identify which business unit is stronger
- explain why
- flag caveats
- identify missing evidence
- avoid unsupported claims

**No direct tool access.**

---

### 6.8 `board-composer-agent`
**Purpose:** present the answer in the requested format.

**Formats**
- concise answer
- analyst memo
- board-ready summary
- table + narrative
- exception report

**No source access.**
Consumes only the reasoning output and metric pack.

---

## 7. Example End-to-End Flow

### User request
“Please give me COGS / GP / REV / NET and ROAS for Burleigh and Brisbane for March, highlight which branch is doing better, and present it board-ready with table + explanation.”

### System flow
1. `intent-router-agent` extracts:
   - metrics: revenue, cogs, gross_profit, net_profit, roas
   - dimension: business_unit = [Ride Electric Burleigh, Ride Electric Brisbane]
   - period: March
   - mode: board_ready

2. `source-planner-agent` resolves:
   - Odoo Profit and Loss for Burleigh and Brisbane
   - external or Odoo ad-spend source for ROAS
   - derived metrics: gross_profit, roas
   - presentation mode: board_ready

3. `odoo-report-extractor-agent` fetches P&L for each business unit.

4. `external-spend-extractor-agent` fetches March ad spend for each business unit if required.

5. `report-normalizer-agent` converts the raw report outputs into normalized report lines.

6. `metric-assembler-agent` computes:
   - revenue
   - cogs
   - gross_profit
   - net_profit
   - ad_spend
   - roas
   - comparison deltas

7. `finance-reasoner-agent` determines which branch is stronger and why.

8. `board-composer-agent` renders:
   - summary
   - comparison table
   - short explanation
   - caveats

---

## 8. Metric Registry Design

Maintain all metric definitions outside prompts.

### Required fields per metric
- `metric_key`
- `label`
- `source_family`
- `primary_source_key`
- `source_semantic`
- `derived`
- `formula`
- `dependencies`
- `required_dimensions`
- `failure_mode`
- `notes`

### Core starter metrics
- revenue
- cogs
- gross_profit
- gross_margin_pct
- net_profit
- ebitda
- ad_spend
- roas
- ar_balance
- ap_balance
- cash_balance
- tax_payable

---

## 9. Dimension Registry Design

Maintain all business dimension mappings explicitly.

### Required fields per dimension value
- user-facing aliases
- exact Odoo value
- dimension type
- source applicability
- confidence policy

### Starter dimensions
- business_unit / company_scope
- channel
- journal
- brand
- period
- comparison_window

---

## 10. Source Registry Design

Every source must declare:
- system
- source kind
- supported metrics
- supported dimensions
- required params
- extractor implementation key
- output contract
- fallback
- freshness expectations

---

## 11. Report Source Strategy

### 11.1 Strategic finance questions
Prefer:
- Profit and Loss
- Balance Sheet
- Cash Flow
- Trial Balance
- Aged Receivables
- Aged Payables
- Tax Report
- Budget Report

### 11.2 Operational finance questions
Prefer:
- journal dashboard views
- reconciliation views
- General Ledger
- Journal Report

### 11.3 Hybrid questions
Examples:
- branch performance
- channel efficiency
- ROAS
- margin vs spend

Use:
- accounting report + external spend source + deterministic assembly

---

## 12. Odoo Integration Strategy

### Required principle
Use existing Odoo accounting report functions/endpoints, not custom SQL.

### Possible access patterns
1. Direct report endpoint returning structured data
2. Report method invoked through Odoo API wrapper
3. Rendered report payload parsed into machine format only if direct structured output is unavailable

### Extraction requirements
- read-only access
- explicit filter params
- exact business-unit scope
- date range
- journal scope
- posted/draft flags
- analytic or branch selector when supported

---

## 13. Normalized Contracts

### 13.1 `IntentPayload`
```json
{
  "intent": "comparative_branch_performance",
  "metrics": ["revenue", "cogs", "gross_profit", "net_profit", "roas"],
  "dimensions": {
    "business_unit": ["Ride Electric Burleigh", "Ride Electric Brisbane"]
  },
  "period": {
    "date_from": "2026-03-01",
    "date_to": "2026-03-31"
  },
  "presentation_mode": "board_ready"
}
```

### 13.2 `SourcePlan`
```json
{
  "sources": [
    {
      "source_key": "profit_and_loss",
      "system": "odoo",
      "purpose": ["revenue", "cogs", "net_profit"],
      "params": {
        "date_from": "2026-03-01",
        "date_to": "2026-03-31",
        "business_unit": "Ride Electric Burleigh",
        "posted_only": true
      }
    }
  ],
  "derived_metrics": [
    {
      "metric": "gross_profit",
      "formula": "revenue - cogs"
    }
  ]
}
```

### 13.3 `NormalizedReport`
```json
{
  "report_key": "profit_and_loss",
  "business_unit": "Ride Electric Burleigh",
  "period": {
    "date_from": "2026-03-01",
    "date_to": "2026-03-31"
  },
  "lines": [
    {
      "code": "operating_income",
      "label": "Operating Income",
      "section": "income",
      "value": 0,
      "level": 1,
      "parent_code": null
    }
  ]
}
```

### 13.4 `MetricPack`
```json
{
  "period": "2026-03",
  "dimension": "business_unit",
  "rows": [
    {
      "business_unit": "Ride Electric Burleigh",
      "revenue": 0,
      "cogs": 0,
      "gross_profit": 0,
      "net_profit": 0,
      "ad_spend": 0,
      "roas": 0
    }
  ],
  "confidence": {
    "revenue": "high",
    "roas": "medium"
  },
  "gaps": []
}
```

---

## 14. Prompting Policy

### Router prompt
- accept only user intent extraction
- never invent Odoo filters
- prefer configured dimension mappings
- return JSON only

### Reasoner prompt
- reason only over metric pack
- never claim source values not present
- never back-solve missing metrics without explicit formula
- surface caveats for missing spend or missing branch attribution

### Composer prompt
- no new calculations
- no new facts
- format only

---

## 15. Token Efficiency Rules

1. Never pass raw Odoo UI blobs to the reasoner.
2. Strip decorative fields before LLM consumption.
3. Convert all formatted numeric strings to numbers before reasoning.
4. Use semantic line codes, not verbose labels where possible.
5. Cache normalized report outputs keyed by parameter hash.
6. Reuse assembled metric packs for multiple presentation modes.
7. Use one reasoner pass, one composer pass.
8. Keep prompts short and contractual.

---

## 16. Caching Strategy

### Cache levels
- report response cache
- normalized report cache
- metric pack cache
- final presentation cache

### Cache key components
- source key
- business unit scope
- date range
- journal scope
- posted_only
- comparison mode
- analytic grouping

---

## 17. Failure Modes

### Missing dimension mapping
Return:
- `requires_configuration`
- missing dimension aliases
- no fallback guess

### Missing ad spend for ROAS
Return:
- revenue/cogs/gross_profit/net_profit
- `roas_status = unavailable`
- clear caveat

### Unsupported report filter
Return:
- partial capability
- required human configuration

### Ambiguous “NET”
Require a configured definition:
- net_profit_before_tax
- net_profit_after_tax
- net_sales

---

## 18. Build Order

### Phase 0 — live-system discovery
Confirm in the actual Odoo instance:
- exact API/report endpoints
- exact business-unit dimension behavior
- whether selector values match company entities
- whether P&L supports this scope directly
- exact semantics for `NET`

### Phase 1 — registries
Build:
- metric registry
- dimension registry
- source registry

### Phase 2 — contracts and planner
Build:
- intent parser
- source planner
- schema validation
- source plan execution model

### Phase 3 — extractors and normalizer
Build:
- Odoo extractor
- external spend extractor
- report normalizer

### Phase 4 — assembly and reasoning
Build:
- metric assembler
- finance reasoner
- board composer

### Phase 5 — deployment
Build:
- API service
- job orchestration
- cache
- monitoring
- test suite

---

## 19. Testing Strategy

### Unit tests
- metric formulas
- dimension resolution
- source planning
- normalization
- board composer formatting

### Integration tests
- live Odoo report calls
- parameterized business-unit comparisons
- March vs other month comparisons
- posted-only filter behavior

### Acceptance tests
- branch comparison
- ROAS with external spend
- missing spend caveat
- multi-business-unit board output

---

## 20. Security and Governance

- Odoo connection must be read-only for this service
- no write access in any finance retrieval agent
- all source executions logged
- user prompt never passed directly into raw report executor
- only validated source plans can execute
- output must include caveats when dependencies are missing

---

## 21. Deployment Shape

Recommended deployment:
- Node/TypeScript service
- separate modules per agent capability
- JSON schema validation at each boundary
- Redis or equivalent for caching
- optional job queue for heavy comparative report generation

---

## 22. Recommendation

Build this yourself first.

Reason:
- the required logic is mostly routing, deterministic assembly, and thin Odoo integration
- your token-efficiency goal favors a small custom stack
- third-party frameworks add abstraction before you have stabilized your contracts

Use a packaged framework later only if:
- you want broad in-Odoo agent tooling
- you need faster connector coverage
- you need built-in MCP exposure
- you need managed orchestration inside Odoo

---

## 23. Deliverables Included in This Package

- detailed build document
- agent contracts
- metric registry
- dimension registry
- source registry
- prompts
- schemas
- example queries
- starter ChatGPT skill for the orchestration workflow
