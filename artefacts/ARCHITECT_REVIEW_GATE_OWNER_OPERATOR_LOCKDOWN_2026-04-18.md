# Architect Review Gate - Owner-Operator Lockdown (2026-04-18)

## Scope Reviewed

- `backend/src/ghostdash_api/workflows.py`
- `backend/src/ghostdash_api/agent_ingress.py`
- `backend/src/ghostdash_api/runtime_profiles.py`
- `backend/src/ghostdash_api/schemas.py`
- `backend/src/ghostdash_api/control_api.py`
- `backend/src/ghostdash_api/models.py`
- `backend/src/ghostdash_api/schema_migrations.py`
- `stack/docx-templater/server.js`
- `Caddyfile`
- `ui/src/pages/chat/MessageList.tsx`
- `ui/src/pages/AgentConfigPage.tsx`
- `ui/src/api.ts`

## Findings and Decisions

### 1) Planner determinism for buyer failures

- **Finding (high):** Mixed finance (`revenue + cogs + margin`) and branch underperformer prompts previously had non-deterministic operation selection.
- **Decision:** **Accepted and fixed.**
- **Implementation:** Added explicit mixed-finance predicate and branch-ranking route predicate to force `odoo.finance.margin.period_summary` and `odoo.finance.margin.monthly_comparison` respectively.
- **Risk status:** reduced.

### 2) Owner response contract drift

- **Finding (high):** Closeout replies could still miss contract sections (facts/inferences/assumptions, freshness line).
- **Decision:** **Accepted and fixed.**
- **Implementation:** Added owner-operator directives and post-answer normalization that injects structured sections when absent.
- **Risk status:** reduced, still model-quality dependent.

### 3) Doc pipeline reliability vs artifact reachability

- **Finding (high):** Sidecar produced mock artifacts without durable retrieval path.
- **Decision:** **Accepted and fixed (phase-1).**
- **Implementation:** Sidecar now persists generated artifacts, exposes static `/docx-artifacts/`*, and returns deterministic diagnostics; Caddy routes `/docx-artifacts/`* to sidecar.
- **Residual risk:** DOCX binary generation remains placeholder-grade for now.

### 4) Guardrail policy governance enforcement

- **Finding (critical):** Policy lock semantics were not server-enforced at runtime-profile write path.
- **Decision:** **Accepted and fixed (phase-1 controlled lock).**
- **Implementation:** Added policy mode (`locked|admin_approval_required|open`), server-side enforcement in runtime-profile save path, and policy change audit persistence.
- **Residual risk:** Token model is string-based and not yet integrated with user identity provider.

### 5) UI readability and chat decision trust

- **Finding (medium):** Assistant output rendering quality was too plain for business operators.
- **Decision:** **Accepted and fixed.**
- **Implementation:** Message renderer upgraded with structured block parsing for headings/tables/lists/code/images and stable display behavior.
- **Residual risk:** Renderer is custom and should later be replaced with full markdown/GFM parser package once package-manager tooling is normalized.

## Risk Accept/Reject Log

- **Accepted risk:** Placeholder DOCX binary generation in sidecar for phase-1 (kept due speed-to-stability objective).
- **Accepted risk:** Approval token uses manual admin token entry pending identity-backed approvals.
- **Rejected risk:** Any planner path that falls back to revenue-only for mixed finance closeout prompts.
- **Rejected risk:** Any policy edit path that bypasses policy mode enforcement.

## Pre-Merge Gate Decision

- **Status:** Conditionally ready for buyer validation.
- **Conditions:** Complete runtime smoke and human scenario validation protocol before merge, and verify policy audit rows are emitted for approved and blocked edits.