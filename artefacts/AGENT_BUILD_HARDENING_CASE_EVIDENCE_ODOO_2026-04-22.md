# Agent Build Hardening - Case / Evidence / Odoo Ops (2026-04-22)

## Objective

Harden GhostDASH multi-agent behavior with explicit role contracts so the system is auditable and less likely to wander:

1. Case Framing Agent
2. Evidence Retrieval Agent
3. Odoo Operations Agent

## Implemented Changes

- Added `backend/src/ghostdash_api/agent_builds.py`:
  - `CaseFramingOutput` contract
  - `EvidenceRetrievalOutput` contract
  - `OdooOperationActionRequest` contract
  - Strict parser for structured Odoo action JSON (`parse_odoo_operation_action_request`)
  - Tool-plan builder for Odoo operations (`build_odoo_action_tool_plan`)
- Extended workflow mode support:
  - `case_framing`
  - `evidence_retrieval`
  - `odoo_operations`
- Updated ingress workflow handling:
  - `case_framing`: bypass planner tool execution and force framing-only prompt contract.
  - `evidence_retrieval`: adds strict factual evidence-pack prompt contract (no recommendations/actions).
  - `odoo_operations`: requires structured JSON request; rejects free text and blocks execution when invalid.
- Strengthened mode directives in system prompt for all three hardened roles.

## Enforcement Summary

- Case Framing Agent:
  - No tool execution path in this mode (`tool_plan.mode = none`).
  - Prompt contract constrained to case-definition fields only.
- Evidence Retrieval Agent:
  - Prompt contract constrained to evidence pack with attribution/freshness/contradictions/missing-data.
  - No prescriptive/action framing in directives.
- Odoo Operations Agent:
  - Free-text requests are rejected at parser boundary.
  - Required fields enforced: `target_model`, `operation`, `field_whitelist`, `reason`, `approval_state`.
  - Field whitelist constraints applied for supported read operations.

## Added Tests

- `backend/tests/test_agent_builds.py`
  - Valid structured Odoo action request accepted.
  - Free-text/non-JSON request rejected.
  - Non-whitelisted fields rejected.
- `backend/tests/test_agent_ingress_prompt_hotfix.py`
  - New hardened workflow modes resolve correctly.

## Operational Notes

- This hardening is intentionally policy-first and deterministic at ingress/contract boundaries.
- Future phase: route these three roles into dedicated UI selectors and explicit workflow-run nodes for end-to-end traceability in run events.

## BP Mode Extension (2026-04-22)

- Added isolated `bp_mode` workflow contract across backend and UI.
- Added BP role prompts/contracts:
  - case framing contract prompt
  - lead architect execution contract
  - auditor gate contract
- Added BP workflow definition `bp_mode_closeout_v1` and run-event support for:
  - `BP_AUDIT_EVALUATED`
  - `BP_AUDIT_PASSED`
  - `BP_AUDIT_FAILED`
- Enforced no-cache behavior for BP mode in sync and stream ingress paths.
- Added BP data-quality payload fields on executed Odoo events:
  - `fresh_data_requested`
  - `data_accuracy_probability`
  - `confidence_weighting_note`
- Added deterministic planning route for Burleigh/Brisbane COGS/GP/Revenue/Net/ROAS scorecard prompts.
- Added expandable BP running-list UI panel and board-pack render components (comparison table + lightweight charts).
