# BP Mode Streaming Presentation Hardening (2026-04-22)

## Objective

Harden BP-mode user-facing presentation so:

1) Internal "thinking/running" telemetry is collapsed by default and shown as a compact status line with green spinner.
2) Visible streamed answer remains board-ready and never leaks low-quality fragments such as "Need use odoo tool likely."
3) Incomplete grounded evidence in BP-mode is rendered as a deterministic, executive-safe provisional template instead of unstable ad hoc prose.

## Implementation Summary

### Backend normalization hardening

- File: `backend/src/ghostdash_api/agent_ingress.py`
- Added `_remove_low_quality_response_artifacts()` to strip low-quality lead-ins before final answer normalization.
- Added BP-mode grounding extractor:
  - `_extract_bp_branch_metric_grounding()`
  - `_build_bp_missing_grounding_response()`
- Updated `normalize_finance_closeout_answer(...)` to:
  - accept `workflow_mode`
  - enforce BP-mode provisional template when Burleigh/Brisbane KPI grounding is incomplete
  - return structured sections:
    - `1) Headline Performance Summary`
    - `2) KPI Scorecard (current, prior, variance)`
  - include italicized provisional notes for rendering in small-note style.

### Frontend UX hardening for hidden thinking

- File: `ui/src/pages/chat/ChatArea.tsx`
  - BP Running List now defaults to collapsed (`bpPanelOpen=false`).
  - Grid layout narrows telemetry column when collapsed.
  - Passes `busy` state into BP feed panel for live status indication.

- File: `ui/src/components/chat/BpRunFeedPanel.tsx`
  - Added compact collapsed mode with live status text.
  - Added green "Thinking" badge with spinner while run is active.
  - Keeps full expand/collapse behavior for detailed telemetry inspection.

### Frontend note styling

- File: `ui/src/pages/chat/MessageList.tsx`
  - Inline parser now supports italic tokens (`*text*`) and renders them in smaller italic style.
  - Enables bottom-note styling requirement in streamed responses.

### Test coverage

- File: `backend/tests/test_agent_ingress_prompt_hotfix.py`
  - Added regression tests for:
    - low-quality lead-in cleanup
    - BP-mode provisional rewrite when grounding is incomplete

## Why this is fit-for-purpose

- Prevents user-facing quality regressions from raw model fragments.
- Enforces safe executive framing when branch KPI evidence is missing.
- Preserves transparency via expandable telemetry without cluttering the main conversation surface.

## Acceptance Criteria

- BP-mode "thinking" details are collapsed by default and expandable on demand.
- A compact green spinner/status line is visible while BP-mode runs.
- Low-quality lead-ins are removed before final answer presentation.
- Incomplete BP branch grounding yields deterministic provisional KPI output instead of unstable prose.
- Typecheck/lint and targeted backend tests pass.

## Verification Commands

- `pytest backend/tests/test_agent_ingress_prompt_hotfix.py -k "low_quality_response_artifacts or bp_mode_rewrites_when_grounding_missing or normalize_business_abbreviations"`
- `npm --prefix ui run lint`
- `docker logs --tail=120 ghoststack-rag-agent-ingress-1`
- `docker logs --tail=120 ghoststack-rag-control-api-1`

## Human E2E Test Script

1. Open BP mode and submit:
   - `Please give me COGS/GP/REV/NET and ROAS for Burleigh and Brisbane for March, board-ready.`
2. Confirm default UI:
   - Running list is collapsed.
   - Compact status shows green spinner with updating text while busy.
3. Expand running list and verify telemetry event trail.
4. Validate final visible response:
   - starts with `1) Headline Performance Summary`
   - includes provisional KPI table section
   - does not contain "Need use odoo tool likely"
   - includes italicized note lines at bottom.
