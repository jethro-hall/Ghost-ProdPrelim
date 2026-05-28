# Doc Generator Detail + Format Parity Plan (2026-04-19)

## Objective

Guarantee that high-detail board strategies, plans, memos, and financial reports:

1. render clearly in chat,
2. follow a consistent board-ready formatting contract, and
3. can be exported through doc mode (preview/finalize) to Word/PDF artifacts without validation failure.

## Current Validation Findings

Evidence snapshot captured:

1. `git status -sb`
2. `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
3. `docker logs --tail=120 ghost-edge-gateway` -> container missing
4. `docker logs --tail=120 ghost-control-plane` -> container missing

Doc mode smoke-test with high-detail payload:

- `preview`:
  - status `200`
  - `docx_artifacts=3`
  - diagnostics `0`
- `finalize`:
  - status `200`
  - diagnostics include:
    - `docx_finalize_validation_failed`
    - missing required sections: `facts`, `inferences`, `assumptions`, `risks`, `actions`

Conclusion:
- detailed chat handling is working enough for preview,
- finalize reliability is not yet deterministic for all runtime/agent prompt variants.

## Root Cause

Finalize has a strict structural validator in ingress, but not every active runtime profile guarantees section-conformant output for document requests. This creates a mismatch between:

- conversational prompt behavior,
- documenter intent,
- finalize structural contract.

## Plan to Close the Gap

### 1) Introduce a single canonical board-output schema

Create one canonical section schema reused by:

- chat formatting directives,
- documenter prompt directives,
- finalize validation.

Target sections:

1. Facts
2. Inferences
3. Assumptions
4. Risks
5. Actions
6. Decision Requests

### 2) Runtime-profile format contract hardening

Add runtime-profile guardrail fields for:

- `board_document_format_contract`
- `financial_report_format_contract`

Expose them in Agent Config UI so operator-defined standards can be edited and saved per runtime profile.

### 3) Pre-finalize normalization pass

Before calling `/render/finalize`, normalize answer content into required sections:

- map equivalent headings (e.g. "executive risks" -> `Risks`)
- auto-insert missing headings as `PROVISIONAL` blocks instead of failing hard
- keep provenance labels for machine-safe bindings

### 4) Template-aware binding rules

Use `/inspect/template` to validate template tags before finalize:

- verify required tags
- map canonical sections to available template tags
- emit plain-language diagnostics if tags are missing

### 5) Export pipeline verification

Add automated integration test:

- high-detail prompt (>10k chars context)
- `docx_mode.preview` returns artifacts
- `docx_mode.finalize` returns artifacts with no missing-section diagnostics
- generated DOCX/HTML/JSON links are reachable through caddy route

## Acceptance Criteria

1. Board strategy/plan/memo outputs in chat follow the same section order every run.
2. Financial reports always include KPI table + variance + cash/runway + risks/actions.
3. `docx_mode.finalize` succeeds for high-detail prompts without `docx_finalize_validation_failed`.
4. Exported artifacts are accessible and persist through the existing document panel flow.
5. Operator can edit board/financial formatting contracts from runtime profile UI.

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-caddy-1
docker logs --tail=120 ghoststack-rag-control-api-1
```

```bash
cd /var/llamaindex/ghoststack-rag/backend
pytest -q tests/test_agent_ingress_prompt_hotfix.py tests/test_runtime_profiles.py
```

```bash
cd /var/llamaindex/ghoststack-rag/ui
npm run lint && npm run build -- --outDir dist-verify-interactive-chat
```

```bash
cd /var/llamaindex/ghoststack-rag
python3 scripts/load/workflow_run_smoke_load.py --base-url http://localhost --iterations 6 --concurrency 2
```
