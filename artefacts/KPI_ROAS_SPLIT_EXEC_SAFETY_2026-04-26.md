# KPI ROAS Split Exec-Safety Hardening (2026-04-26)

## Objective
Make board KPI comparison output executive-safe by removing ambiguous single `ROAS` labeling and forcing explicit profitability and efficiency dimensions.

## Problem Statement
Comparison outputs showed one `ROAS` KPI that represented revenue-based ROAS under revenue-weighted centralized marketing allocation.  
That can mislead decision makers because:
- Revenue ROAS can be identical across entities under revenue-weighted allocation.
- GP ROAS and contribution margin can still differ materially.

## Implementation Summary

### 1) KPI schema widened for rendered rows
- File: `backend/src/ghostdash_api/odoo_mas/contracts.py`
- `MetricRow` now carries:
  - `gross_margin_pct`
  - `revenue_roas`
  - `gp_roas`
  - `contribution_margin`

### 2) Phase2 deterministic metrics now populate rendered metric rows
- File: `backend/src/ghostdash_api/odoo_mas/phase2_bridge.py`
- `apply_phase2_resolved_metrics_to_metric_pack` now maps:
  - `revenue_roas`
  - `gp_roas`
  - `gross_margin_pct`
  - `contribution_margin`
- Existing `roas` mapping remains as compatibility alias to revenue ROAS.

### 3) Reasoning supports criterion-based winners
- File: `backend/src/ghostdash_api/odoo_mas/reasoner.py`
- Added winner channels:
  - `winner` (gross profit)
  - `efficiency_winner` (GP ROAS)
  - `gross_margin_winner` (gross margin percentage)
- Winner only shown when top value is strictly greater than second value.

### 4) KPI table changed to explicit finance decision columns
- File: `backend/src/ghostdash_api/odoo_mas/composer.py`
- Replaced ambiguous KPI header:
  - from `ROAS`
  - to `Allocated Marketing | Revenue ROAS | GP ROAS | Contribution Margin`
- Added optional winner callouts:
  - `Top performer (gross profit): ...`
  - `Top performer (efficiency / GP ROAS): ...`
  - `Top performer (gross margin %): ...`

## Acceptance Criteria
- KPI output does not present a single ambiguous `ROAS` column.
- KPI table includes all of:
  - `Revenue ROAS`
  - `GP ROAS`
  - `Allocated Marketing`
  - `Contribution Margin`
- Gross profit and efficiency winners can diverge and are surfaced separately when evidence supports it.
- Existing centralized marketing deterministic Phase2 flow remains intact.

## Verification Commands
Run from repo root `ghoststack-rag`:

```bash
pytest -q \
  backend/tests/test_odoo_mas_pipeline.py::test_reasoner_and_composer_show_top_performer_only_for_true_comparison \
  backend/tests/test_odoo_mas_pipeline.py::test_reasoner_and_composer_show_efficiency_winner_when_gp_roas_differs \
  backend/tests/test_odoo_mas_pipeline.py::test_centralized_roas_query_fetches_retail_marketing_for_branch_revenue
```

Expected: `3 passed`

## Runtime Drift + Stream Truth-Lock (Follow-up)

### Issue observed
Even after the KPI table schema fix, live responses could still appear as old/LLM-shaped output when:
- container image was stale (not rebuilt after source edit), and/or
- stream path emitted model deltas before post-normalization, causing narrative drift.

### Runtime fix applied
- Rebuilt/restarted backend services:
  - `docker compose up -d --build agent-ingress control-api`
- Confirmed running container code now includes the split KPI header in:
  - `/app/src/ghostdash_api/odoo_mas/composer.py`

### Stream truth-lock fix applied
- File: `backend/src/ghostdash_api/agent_ingress.py`
- In both sync and stream chat paths, when executed `odoo_mas_v2` markdown is present, set:
  - `plan["direct_answer"] = normalize_business_abbreviations(_render_mas_truth_locked_answer(...))`
- This bypasses freeform LLM rewrite and streams deterministic MAS markdown directly.

### Human-style retest evidence (exact prompt)
Prompt:
`Using Odoo only, show ROAS for Brisbane and Burleigh in March 2026 using centralized marketing.`

Observed in streamed output:
- `## KPI Table` present
- Columns include:
  - `Allocated Marketing`
  - `Revenue ROAS`
  - `GP ROAS`
  - `Contribution Margin`
- Winner split present:
  - gross profit winner: Burleigh
  - efficiency/GP ROAS winner: Brisbane
- `## Execution Truth` present
- cache flag on start event: `cached: false`

### Additional verify command
```bash
python3 - <<'PY'
import json, subprocess
payload={
  "agent_id":"0488d744-c66c-4d0e-9a29-c68fa81ba84f",
  "conversation_mode":"board",
  "workflow_mode":"odoo_specialist",
  "message":"Using Odoo only, show ROAS for Brisbane and Burleigh in March 2026 using centralized marketing."
}
res=subprocess.run(
  ["curl","-i","-sS","-N","-H","Content-Type: application/json","-X","POST","http://localhost/agent/chat/stream","-d",json.dumps(payload)],
  text=True,capture_output=True,check=False
)
print(res.stdout[:4000])
PY
```

## Diagnostic Snapshot Used
- `docker ps` confirmed active stack services.
- `docker logs --tail=120 ghoststack-rag-agent-ingress-1` and `docker logs --tail=120 ghoststack-rag-control-api-1` showed healthy traffic and no blocking errors during this change window.

