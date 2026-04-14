# Mistral Odoo Grounding Hardfix

## Problem

Consumer-chat answers were still producing weak or evasive Odoo responses even though live Odoo access was available.

The investigation found three concrete causes:

1. The planner could route to `odoo.finance.margin.monthly_comparison`, but the live stack rejected that operation as unsupported.
2. Consumer chat was blocked from the low-level governed Odoo operations needed for fallback analysis such as `odoo.rpc.read_group` and transaction-level `odoo.rpc.search_read`.
3. The Odoo planner did not understand explicit month-name periods like `July 2025`, so requests for COGS-code reviews could fall through without a tool plan.

## July 2025 Finance Findings

Using live Odoo data:

- `Ride Electric Retail` was the main July GP drag, but mostly because revenue fell sharply while COGS did not fall enough.
- `Ride Electric Brisbane` showed the clearest direct-cost blowout.
- `Ride Electric Burleigh` was healthy and not the cause of the group issue.

Key July code movements versus the non-July monthly baseline:

- `328 COGS - Accessories`: materially higher, driven mainly by unusual single-move accessory postings in Retail.
- `324 COGS - Nami Scooters`: higher, with concentration in both Retail and Brisbane.
- `342 COGS - FatFish Bikes`: Brisbane-specific pressure remained meaningful.

Suspicious move concentrations identified in live Odoo:

- Retail accessories:
  - `RTINV-14840 (BRL/P01267)` posted about `$26k` to `328 COGS - Accessories` on a single line with quantity `200` of an Abus lock item.
  - `RTINV-15029 (SouthPort Till#1/6289)` posted about `$15.5k` to the same code on one product line.
- Brisbane Nami:
  - multiple `BRINV-*` moves concentrated between roughly `$2.6k` and `$5.3k` each.
- Brisbane FatFish:
  - `BRINV-2216 (BRL/P01212)` posted about `$10.1k`, followed by many repeated moves around `$1.8k` to `$2.5k`.

These patterns suggest some combination of:

- intercompany or cross-store posting behavior,
- unusually large POS/invoice-derived COGS lines,
- and possible costing or revaluation entries sitting inside retail-facing COGS buckets.

## Code Changes

### 1. Consumer chat low-level Odoo access

Expanded governed consumer-chat access to allow:

- `odoo.rpc.read_group` for:
  - `res.company`
  - `account.move`
  - `account.move.line`
  - `sale.order`
  - `sale.order.line`
- `odoo.rpc.search_read` for:
  - `res.company`
  - `account.move`
  - `account.move.line`

This keeps `odoo.rpc.execute_kw` blocked while enabling the exact low-level reads needed for grounded finance diagnostics.

### 2. Monthly comparison fallback

When consumer chat plans `odoo.finance.margin.monthly_comparison` but the live stack returns `Unsupported Odoo operation`, the ingress layer now:

1. executes `odoo.finance.revenue.monthly`
2. executes `odoo.finance.cogs.monthly`
3. synthesizes the same monthly GP comparison structure server-side
4. injects that tool evidence into the prompt instead of leaving the model with a failure and a chance to bluff

### 3. Better period parsing

The planner now understands explicit month-name windows like:

- `July 2025`
- `August 2025`
- `September 2025`

This allows direct tool planning for month-specific ERP questions instead of depending only on phrases like `last month`.

### 4. COGS-code planning

Questions about:

- `COGS code`
- `COGS codes`
- `account code`
- `account codes`

now route to a governed `odoo.rpc.read_group` plan on `account.move.line`, grouped by company and account code for the requested period.

## Files Changed

- `backend/src/ghostdash_api/tool_registry.py`
- `backend/src/ghostdash_api/runtime_profiles.py`
- `backend/src/ghostdash_api/workflows.py`
- `backend/src/ghostdash_api/agent_ingress.py`
- `backend/tests/test_tools_api.py`
- `backend/tests/test_workflows_odoo_planning.py`
- `backend/tests/test_agent_ingress_prompt_hotfix.py`

## Verification

Targeted backend tests:

```bash
pytest backend/tests/test_workflows_odoo_planning.py backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_tools_api.py
```

Result:

- `21 passed`

## Operational Validation

After deploy, validate:

1. A multi-company GP question still returns executed Odoo evidence even if the monthly comparison helper is missing from the live stack.
2. A `COGS codes for July 2025` question now produces grouped account-code evidence instead of a vague strategy-only answer.
3. Tool events in chat show `executed` or explicit blocked/failure states, not implied execution.

Suggested manual prompts:

- `Compare GP across company_id 3, 4, and 5 for the last 4 completed months using Odoo.`
- `Review the Retail COGS codes for July 2025 and show what caused GP to be way out for company_id 3.`

## Remaining Gap

Current consumer-chat orchestration is still effectively a single planned tool action per turn.

That means the system is now much better at:

- code-level aggregation,
- monthly GP comparison fallback,
- and transaction-line drilldowns when explicitly planned,

but it is not yet a full multi-step autonomous finance investigator in one turn.

If exact parity with manual analyst-style drilling is required, the next architectural step is multi-operation tool plans per turn, where the backend can chain:

1. summary aggregate
2. anomaly isolate
3. transaction drilldown

without asking the model to guess between steps.
