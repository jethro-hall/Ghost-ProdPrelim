# Odoo Finance Report Router Build

Version: v1.0
Date/Time: 2026-04-23 Australia/Brisbane (drafted in ChatGPT)
Status: Ready for Cursor implementation
Decision: Build this in-house first. Do not start with Apexive unless you later need Odoo-native UI actions, in-Odoo assistants, or packaged MCP exposure.

## 1. Objective

Build a lean finance reasoning layer that routes natural-language business questions to existing Odoo accounting reports and journal/dashboard functions, extracts only the minimum structured data required, reasons over that data, and returns a business-quality answer.

This system replaces hand-written direct SQL/report queries with a controlled routing architecture:

`user question -> router -> report extractor -> reasoning agent -> response composer`

The goal is to minimize:
- token usage
- custom query maintenance
- brittle business logic outside Odoo
- hallucinated routing decisions
- security risk from unrestricted model access

## 2. Why this architecture

You already have an Odoo connection. The mistake was building custom queries where Odoo already exposes reliable accounting reports and methods.

The correct pattern is:
1. prefer existing accounting reports for finance reasoning
2. use named journal/dashboard entities only for operational reconciliation or payment-rail questions
3. extract compact structured output
4. reason over the structured output, not raw ledger lines unless drilling down

## 3. Recommendation: DIY vs Apexive

### Recommendation
Build this yourself first.

### Why DIY first
- You want lean token usage.
- You already have connectivity.
- Your core requirement is report routing and reasoning, not a full in-Odoo agent platform.
- A small custom layer is easier to govern than a broad framework.
- You avoid framework payload bloat, extra abstractions, and dependency drag.

### When Apexive becomes worth it later
Use Apexive only if you later need one or more of these:
- in-Odoo assistant UI
- packaged MCP server inside Odoo
- broad tool exposure across many Odoo apps
- many standardized finance/accounting tools already implemented
- provider abstraction living inside Odoo

### Final call
Start custom and lean. Keep the boundary thin. Add Apexive only if the in-house layer becomes painful.

## 4. Design principles

1. **Report-first, not query-first**
   - route to Odoo accounting reports first
   - use raw model reads only for narrow drill-downs

2. **Reason over summaries, not transactions**
   - extract aggregated metrics first
   - only fetch detailed lines when confidence is low or user asks why/how

3. **One job per agent**
   - router decides source
   - extractor fetches data
   - reasoner interprets
   - composer writes answer

4. **No unrestricted tool use by the reasoner**
   - reasoner only receives structured evidence

5. **Token discipline everywhere**
   - do not send full chart of accounts
   - do not send entire report HTML
   - do not send unnecessary journal lines
   - use IDs, short labels, and normalized metrics

## 5. Scope

### In scope
- classify business-finance requests
- map requests to standard Odoo accounting reports
- map named operational entities to journal/dashboard sources
- extract normalized JSON from reports
- reason over the extracted JSON
- return concise business answers
- support time ranges and comparisons

### Out of scope for v1
- direct posting or write actions in Odoo
- invoice creation or payment execution
- generic arbitrary SQL generation
- unrestricted natural-language tool calling
- full data warehouse replacement

## 6. Source hierarchy

### Tier 1: default Odoo finance reports
Use these first for broad business reasoning.
- Profit and Loss
- Balance Sheet
- Cash Flow Statement
- Trial Balance
- General Ledger
- Partner Ledger
- Aged Receivables
- Aged Payables
- Tax Report
- Budget Report / Budget vs Actual
- Journal Report

### Tier 2: dashboard journals / custom cards
Use these for operational questions tied to specific payment rails, channels, or reconciliation issues.

Detected from your supplied accounting dashboard PDF:
- Retail Cheque Acc (5418)
- Retail GST Acc (4397)
- Retail Payroll Acc (4307)
- Black Mastercard (7055)
- Shopify - Ride Electric - NEW (5051)
- Retail Parts Acc (7897)
- American Express (61007) NEW
- Retail PSI Locks Acc (7926)
- Shopify - FatFish (7108)
- Shopify - Zero (7079)
- Shopify - Smartmotion (7087)
- Retail Paypal Bank account
- Shopify - Vsett (7095)
- Retail Zip,Afterpay,MyDeal,Ebay,Bunnings (6591)
- RE Retail - Vsett Commbank
- Retail Income Tax Acc (5426)
- Retail Amex (61007)
- Wholesale/Retail Contra (852)
- Wholesale/Retail Contra for Vsett (863)
- Retail/Burleigh Contra (851)
- Wholesale/Retail Payments (871)
- Black Master card (OLD)
- Retail Savings Acc (0488)
- Ride Electric Shopify (OLD)
- Cash
- Cash (SPT 2)

## 7. High-level architecture

```text
User Question
  -> Finance Router Agent
  -> Source Resolver
  -> Odoo Report Extractor
  -> Evidence Normalizer
  -> Finance Reasoner
  -> Response Composer
  -> User Answer
```

Optional drill-down path:

```text
Low confidence or "why" question
  -> Detail Extractor
  -> Evidence Augmentation
  -> Finance Reasoner rerun
```

## 8. Agents to build

### Agent 1: Finance Router
**Purpose**: classify the request and choose the best Odoo source.

**Input**
- user question
- optional conversation context
- known journal entity map
- intent map

**Output**
```json
{
  "primary_intent": "cash_position",
  "secondary_intents": ["receivables"],
  "question_type": "strategic",
  "entities": ["paypal"],
  "time_range": "this_quarter",
  "comparison": false,
  "primary_source": {
    "source_type": "default_report",
    "source_name": "Cash Flow Statement"
  },
  "secondary_sources": [
    {
      "source_type": "default_report",
      "source_name": "Aged Receivables"
    }
  ],
  "confidence": 0.92,
  "reason": "Broad liquidity question; use cash-flow report first and debtors for working-capital pressure."
}
```

**Rules**
- no Odoo access
- output JSON only
- choose one primary source
- choose at most two secondary sources
- prefer default reports over journals unless the question is operational or entity-specific

### Agent 2: Odoo Source Resolver
**Purpose**: convert source names into executable Odoo calls.

**Input**
- router JSON
- source registry

**Output**
- exact report method/function to call
- parameter schema
- permitted filters

**Rules**
- deterministic
- no reasoning
- no fallback guessing beyond registry rules

### Agent 3: Report Extractor
**Purpose**: call the Odoo report/function and return a compact normalized payload.

**Input**
- resolved report function
- company/context
- date range
- comparison flags

**Output**
```json
{
  "source": "Profit and Loss",
  "period": {"from": "2026-01-01", "to": "2026-03-31"},
  "currency": "AUD",
  "metrics": {
    "revenue": 0,
    "cogs": 0,
    "gross_profit": 0,
    "gross_margin_pct": 0,
    "opex": 0,
    "ebitda": 0,
    "net_profit": 0
  },
  "top_positive_drivers": [],
  "top_negative_drivers": [],
  "raw_reference": {
    "report": "profit_and_loss",
    "execution_id": "..."
  }
}
```

**Rules**
- no prose beyond brief notes
- compact JSON only
- cap line items to top-N where possible
- no full report dumps

### Agent 4: Finance Reasoner
**Purpose**: interpret the normalized evidence.

**Input**
- extracted evidence pack
- user question

**Output**
- findings
- confidence
- supporting metrics
- gaps
- optional drill-down requests

**Rules**
- no tool access
- cite source names from evidence
- separate findings from inference
- ask for drill-down only when necessary

### Agent 5: Response Composer
**Purpose**: turn findings into the final answer.

**Input**
- user question
- reasoner output

**Output**
- concise business answer
- supporting bullets
- caveats if needed

**Rules**
- default concise
- no raw JSON in user-facing answer unless requested
- surface uncertainty plainly

## 9. Why not a single agent

Because one-agent designs become sloppy fast:
- routing gets mixed with extraction
- extraction gets mixed with narrative
- prompts bloat
- token costs climb
- debugging becomes guesswork

Small agents with rigid contracts are cheaper and easier to maintain.

## 10. Intent taxonomy

### Strategic intents
- profitability
- cash_position
- financial_position
- receivables
- payables
- budget_variance
- tax_position
- trend_analysis
- vendor_analysis
- customer_analysis

### Operational intents
- reconciliation_status
- payout_mismatch
- journal_activity
- clearing_account_status
- payment_rail_status
- settlement_trace

## 11. Routing rules

### Rule A: default report first for broad business questions
Examples:
- Are we profitable this quarter?
- Why is cash tight?
- What are our biggest expenses?
- How are debtors affecting us?

### Rule B: journal/dashboard first for operational rail or reconciliation questions
Examples:
- What is stuck in PayPal?
- Are Shopify Vsett payouts reconciling?
- What is unreconciled in GST?

### Rule C: entity beats generic topic when the question is narrow
Example:
- What is happening with Vsett settlements?
Use Vsett journals first.

### Rule D: combine report + journal when the question is entity-specific and strategic
Example:
- Is Vsett profitable?
Use P&L or equivalent performance report first, then Vsett journals for support.

## 12. Lean token strategy

### Mandatory controls
- never include full report trees unless requested
- cap top line-item lists to 5 or 10
- normalize numbers, labels, and percentages only
- avoid sending duplicated labels and sections
- maintain short source IDs
- summarize history aggressively after each exchange

### Suggested payload limits
- router prompt: <= 800 tokens
- extractor result: <= 2 KB JSON for single-source answers
- evidence pack for reasoner: <= 4 KB JSON
- final response: <= 250 tokens by default

### Compression pattern
Convert this:
```json
{"Operating Expenses": {"Payroll": 123, "Rent": 45, "Marketing": 67, ...}}
```
into this:
```json
{
  "opex_total": 235,
  "top_opex": [
    ["Payroll", 123],
    ["Marketing", 67],
    ["Rent", 45]
  ]
}
```

## 13. Data contracts

### Router output schema
See `schemas/router-output.schema.json`.

### Extracted evidence schema
See `schemas/evidence-pack.schema.json`.

## 14. Source registry design

Create a registry that maps friendly source names to implementation details.

Example:
```json
{
  "Profit and Loss": {
    "source_type": "default_report",
    "odoo_key": "profit_and_loss",
    "allowed_filters": ["date_from", "date_to", "comparison", "company_id"],
    "extractor": "extract_profit_and_loss"
  },
  "Retail Paypal Bank account": {
    "source_type": "journal_dashboard",
    "journal_key": "Retail Paypal Bank account",
    "allowed_filters": ["date_from", "date_to", "company_id"],
    "extractor": "extract_journal_status"
  }
}
```

Do not let the LLM invent function names. It must choose only from the registry.

## 15. Odoo integration strategy

### Preferred
Use existing report methods or controller endpoints already available in your Odoo environment.

### Fallback
If a default report cannot return compact structured data directly, create a thin adapter in your app layer that:
- calls the report once
- converts the result into normalized JSON
- strips presentation-only elements

### Important
Do not let the LLM query raw accounting models for standard business questions if a standard report already exists.

## 16. Detailed implementation phases

### Phase 0: discovery
Deliverables:
- validate all standard finance reports available in your Odoo version
- confirm callable methods/endpoints for each report
- confirm journal identifiers and names
- confirm what filters are supported
- capture example outputs

### Phase 1: registry
Deliverables:
- `config/finance_intent_map.json`
- `config/journal_entity_map.json`
- `config/source_registry.json`

### Phase 2: router
Deliverables:
- router prompt
- router schema validation
- example test cases
- confidence policy

### Phase 3: extractors
Deliverables:
- one extractor per standard report group
- one generic journal status extractor
- date-range parameter handling
- comparison support
- compact response shaping

### Phase 4: reasoner
Deliverables:
- finance-reasoner prompt
- evidence pack format
- finding templates
- drill-down policy

### Phase 5: composer
Deliverables:
- concise final answer prompt
- response styles: executive / operational / analyst

### Phase 6: evaluation
Deliverables:
- golden questions set
- expected route assertions
- accuracy score
- token/cost/latency budget

## 17. Build details for Cursor

### Recommended stack
- TypeScript
- Zod or JSON Schema validation
- one registry file loaded at boot
- deterministic tool layer around Odoo
- OpenAI Responses API or Chat Completions with strict JSON schema for router

### Folder layout
```text
src/
  config/
    finance_intent_map.json
    journal_entity_map.json
    source_registry.json
  agents/
    financeRouter.ts
    sourceResolver.ts
    financeReasoner.ts
    responseComposer.ts
  extractors/
    profitAndLoss.ts
    balanceSheet.ts
    cashFlow.ts
    agedReceivables.ts
    agedPayables.ts
    taxReport.ts
    journalStatus.ts
  schemas/
    router-output.schema.json
    evidence-pack.schema.json
  services/
    odooClient.ts
    reportRunner.ts
    normalizer.ts
  tests/
    router.spec.ts
    regression.spec.ts
```

### Core runtime flow
1. run router
2. validate router JSON
3. resolve source(s)
4. execute extractor(s)
5. normalize evidence
6. run reasoner
7. compose response
8. log route, latency, tokens, and confidence

## 18. Risk register

### Risk: report availability differs by Odoo version/customization
Mitigation:
- registry built from your actual environment, not assumptions

### Risk: journal names change
Mitigation:
- keep stable internal entity IDs and external aliases

### Risk: router overuses journals
Mitigation:
- hard rule favoring standard reports for strategic questions

### Risk: token blowout from detailed lines
Mitigation:
- cap details and require drill-down trigger

### Risk: LLM makes unsupported routing choice
Mitigation:
- strict schema + registry validation + reject unknown source names

## 19. Testing plan

### Route tests
At minimum test 50 questions across:
- profitability
- liquidity
- debtors
- creditors
- GST/tax
- reconciliation
- Shopify channel issues
- Vsett issues
- PayPal issues
- contra account issues

### Assertions
For each test assert:
- chosen primary intent
- chosen primary source
- whether strategic vs operational is correct
- whether entity detection is correct
- whether fallback source is sensible

### Example route assertions
- "Are we profitable this quarter?" -> Profit and Loss
- "Why is cash tight?" -> Cash Flow Statement + Aged Receivables
- "What is stuck in PayPal?" -> Retail Paypal Bank account
- "Are Vsett payouts reconciling?" -> Shopify - Vsett / RE Retail - Vsett Commbank / Contra for Vsett
- "How much GST do we owe?" -> Tax Report, fallback Retail GST Acc

## 20. Minimal viable release

### Must-have
- router
- registry
- top 6 default reports
- journal entity map
- one journal status extractor
- finance reasoner
- tests for at least 25 questions

### Nice-to-have
- comparison periods
- board-summary style
- multi-company support
- budget variance
- partner-level drill-down

## 21. Suggested OpenAI usage pattern

### Router model
Use a smaller fast model with strict JSON output.

### Reasoner model
Use a stronger model only after extraction. Keep evidence compact.

### Composer model
Can usually be the same as router or skipped by folding composition into reasoner if needed.

### Important
The expensive model should not do source discovery or raw extraction.

## 22. Skill suggestions

You do not need heavy ChatGPT Skills for the runtime product. For the build workflow, the useful reusable skills are:

1. **odoo-finance-router**
   - design and maintain the routing registry and prompts
2. **odoo-report-catalog-maintainer**
   - update source registry from Odoo report changes
3. **finance-router-evaluator**
   - run regression questions and compare route quality

For v1, only the first one is worth creating. The others can wait.

## 23. Final recommendation

Build this yourself.

Keep it narrow:
- report-first
- strict registry
- compact evidence
- separate router from reasoner
- no SQL generation

That will be leaner, cheaper, and easier to trust than dropping in a broad framework too early.

## 24. Approval checkpoint for next build step

Before coding, approve these decisions:
1. default reports are the primary truth source
2. journals are only for operational/entity-specific drill-downs
3. no generic SQL generation in v1
4. strict registry validation blocks unsupported routes
5. build custom first, Apexive later only if necessary

