# Odoo Agent System Prompt Alignment

## Problem

The default GhostDASH strategic agent prompt was strong on business reasoning, but it did not explicitly teach the model how to use the repo's canonical Odoo toolkit contract.

That left three material risks:

- the agent could infer the wrong Odoo contract from archived handover material
- the agent could treat Odoo as generically available instead of checking runtime readiness
- the agent could answer with plausible ERP claims without proving an actual `odoo_primary` call happened

## Canonical contract confirmed

The authoritative Odoo path in this repo is the Python backend tool:

- tool id: `odoo_primary`
- execute route: `POST /api/tools/odoo_primary/execute`
- test route: `POST /api/tools/odoo_primary/test`

The archived Node `odoo-rpc` bundle under `artefacts/odoo_bundle_reference/` is useful as historical context only. It is not the canonical agent contract for this backend.

## Prompt changes applied

The default runtime system prompt in `backend/src/ghostdash_api/runtime_profiles.py` now explicitly instructs the agent to:

- use `odoo_primary` as the only canonical Odoo contract
- reject archived or invented Odoo operation contracts
- check runtime readiness before any Odoo-dependent answer
- treat `disabled_for_agent`, `disabled_for_session`, `missing_config`, `disabled_globally`, and `unhealthy` as unavailable states
- provide only `operation` and `payload` when using Odoo
- prefer named safe operations before generic RPC
- prefer `odoo.rpc.read_group` and quarterly finance helpers for KPI and trend analysis
- use explicit `fields`, `domain`, `company_id`, `limit`, and `offset`
- minimize PII and avoid heavy exploratory pulls
- never claim Odoo data was fetched unless tool output is actually present

## Why this matters

This change reduces prompt-level contract drift between:

- business-analysis behavior
- runtime tool policy and readiness state
- the Python `odoo_connector.py` implementation

Without these instructions, the model could remain commercially articulate while still being operationally unsafe or technically wrong.

## Acceptance criteria

- the default strategic agent prompt names `odoo_primary` explicitly
- the prompt tells the agent to gate on tool readiness before calling Odoo
- the prompt prefers safe named operations and analytics-friendly `read_group`
- the prompt forbids claiming tool use without actual output
- the prompt preserves the original business-analysis behavior while adding repo-true Odoo behavior

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag && python - <<'PY'
from ghostdash_api.runtime_profiles import DEFAULT_SYSTEM_PROMPT
checks = [
    "odoo_primary",
    "disabled_for_agent",
    "odoo.rpc.read_group",
    "Never claim that an Odoo lookup",
]
missing = [item for item in checks if item not in DEFAULT_SYSTEM_PROMPT]
print("missing:", missing)
raise SystemExit(1 if missing else 0)
PY
cd /var/llamaindex/ghoststack-rag/backend && pytest tests/test_tools_api.py -q --tb=no
cd /var/llamaindex/ghoststack-rag && git status -sb
```

## Human validation

1. Open the agent configuration UI.
2. Confirm the strategic agent still presents as a business-analysis agent, not a generic technical assistant.
3. Enable Odoo for a testable agent profile.
4. Ask a store-specific finance question and confirm the answer either:
   - uses actual Odoo-backed evidence when the tool is ready, or
   - clearly states why Odoo was not callable and what exact data is missing.
