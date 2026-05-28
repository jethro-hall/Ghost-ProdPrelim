# Phase 2.5 Finance UX / Report Rendering (2026-04-26)

## Goal
Block Phase 3 until Phase 2 finance output is executive-safe:
- `chat_summary_card`
- `apryse_report_document`

## Implemented Backend Contract

### Files
- `backend/src/ghostdash_api/finance_report_renderer.py`
- `backend/src/ghostdash_api/odoo_mas/pipeline.py`
- `backend/src/ghostdash_api/control_api.py`

### Contract
`run_odoo_mas_pipeline` now returns:
- `chat_summary_card`
- `apryse_report_document`

The card payload includes:
- `status`
- `source_mode`
- `period`
- `question_type`
- `currency`
- `allocation`
- `entities`
- `winners`
- `executive_readout`
- `interpretation`
- `caveats`
- `evidence`

### Report API
- `GET /api/finance/reports/{run_id}`
- `GET /api/finance/reports/{run_id}/pdf`
- `GET /api/finance/reports/{run_id}/html`

Reports are persisted under `/data/finance_reports` in Docker. Local test/dev falls back to `/tmp/ghostdash_finance_reports` if `/data` is not writable.

## Implemented Ghost ChatUI Rendering

### Files
- `/var/Ghost-chatUI/src/components/finance/FinanceAnswerCard.tsx`
- `/var/Ghost-chatUI/src/components/finance/FinanceMetricTable.tsx`
- `/var/Ghost-chatUI/src/components/finance/FinanceEvidenceDrawer.tsx`
- `/var/Ghost-chatUI/src/components/finance/ApryseReportViewer.tsx`
- `/var/Ghost-chatUI/src/components/chat/MessageBubble.tsx`
- `/var/Ghost-chatUI/src/lib/types/chat.ts`
- `/var/Ghost-chatUI/scripts/copy-webviewer-assets.mjs`
- `/var/Ghost-chatUI/Dockerfile`
- `/var/Ghost-chatUI/package.json`

### Behavior
- Assistant messages with executed `odoo_primary` tool payloads containing `chat_summary_card` render as `FinanceAnswerCard`.
- Raw deterministic payload is hidden behind `View calculation details`.
- `Open Report` opens `ApryseReportViewer`.
- Non-blocking `agent.orchestrator` failure is shown as a small warning:
  `Auxiliary orchestrator failed; deterministic Odoo finance calculation completed.`
- Generic tool chips are hidden for finance cards so `agent.orchestrator: failed` does not pollute the headline.

## Verification

### Backend tests
```bash
cd /var/llamaindex/ghoststack-rag
pytest -q \
  backend/tests/test_finance_report_renderer.py \
  backend/tests/test_control_api_odoo_mas.py \
  backend/tests/test_odoo_mas_pipeline.py::test_centralized_roas_query_fetches_retail_marketing_for_branch_revenue \
  backend/tests/test_agent_ingress_prompt_hotfix.py
```

Result: `53 passed`

### Frontend
```bash
cd /var/Ghost-chatUI
npm run lint
npm run build
```

Result: both passed after adding `NODE_OPTIONS=--max-old-space-size=4096` to lint/build scripts.

### Live API verification
Prompt:
`Using Odoo only, show ROAS for Brisbane and Burleigh in March 2026 using centralized marketing.`

Observed:
- `chat_summary_card` present.
- `apryse_report_document` present.
- `allocation.pool = 64906.18`
- `allocation.method = revenue_weighted`
- Brisbane:
  - revenue `147204.96`
  - COGS `91995.54`
  - gross profit `55209.42`
  - gross margin pct `0.3751`
  - allocated marketing `22321.21`
  - revenue ROAS `6.5948`
  - GP ROAS `2.4734`
  - contribution margin `32888.21`
- Burleigh:
  - revenue `280841.33`
  - COGS `189058.03`
  - gross profit `91783.33`
  - gross margin pct `0.3268`
  - allocated marketing `42584.97`
  - revenue ROAS `6.5948`
  - GP ROAS `2.1553`
  - contribution margin `49198.36`
- Winners:
  - gross profit: Burleigh
  - gross margin pct: Brisbane
  - GP ROAS: Brisbane
  - contribution margin: Burleigh
- PDF endpoint returns `Content-Type: application/pdf`.

### Live stream verification
The `/agent/chat/stream` response includes:
- `cached: false`
- executed `odoo_primary`
- `chat_summary_card`
- `apryse_report_document`
- non-blocking `agent.orchestrator` failure available for warning display

## Human UI Test Finding
Browser interaction with `ghost_chatui` still has the existing click-interception issue in compact layout when selecting agents. Direct selection of `Finance Agent` failed with intercepted-click errors. This is not part of the finance math/rendering contract, but it blocks a fully manual click-through validation until the layout hit target bug is fixed.

## Acceptance Criteria Status
1. ROAS answer renders as an executive card, not raw dump: implemented in Ghost ChatUI, live stream carries card payload.
2. KPI table includes Gross Margin %, Revenue ROAS, GP ROAS, Contribution Margin: pass.
3. Centralized marketing allocation is clearly disclosed: pass.
4. Raw evidence is expandable, not dumped into main answer: pass in `FinanceEvidenceDrawer`.
5. Apryse opens the report in-app: implemented via `ApryseReportViewer`; requires `VITE_APRYSE_LICENSE_KEY` for full viewer initialization.
6. Odoo-only queries cite only Odoo execution evidence: stream citations are tool-only for Odoo execution.
7. Non-critical orchestrator failure does not pollute main answer: pass in finance card rendering; warning shown separately.
8. Currency, percentages, and floats are formatted properly: pass in structured payload and card renderer.

