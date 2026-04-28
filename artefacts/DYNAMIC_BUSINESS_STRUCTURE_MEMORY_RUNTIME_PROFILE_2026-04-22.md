# Dynamic Business Structure Memory - Runtime Profile (2026-04-22)

## Objective

Remove hardcoded business-entity assumptions and make business structure dynamic per GhostDASH runtime profile, with:

- adjustable structure context in GhostDASH settings UI,
- persisted runtime memory for future turns,
- deterministic question-bank fallback when required context is missing,
- chat-time capture path to bank context updates.

## Canonical owner (single source of truth)

- **Owner:** `RuntimeProfileRecord.guardrails_config_json`
- **Canonical API contract:** runtime profile payload/view through existing control API agent/runtime endpoints
- **Canonical UI editor:** `ui/src/pages/AgentConfigPage.tsx` runtime guardrails section
- **Read path:** `agent_ingress` reads `runtime_profile.guardrails_config_json` only (no duplicate stores)

## Implemented changes

### 1) Runtime defaults and normalization

Updated `backend/src/ghostdash_api/runtime_profiles.py`:

- Added `DEFAULT_BUSINESS_STRUCTURE_QUESTION_BANK`.
- Added guardrails defaults:
  - `business_structure_required`
  - `business_structure_question_bank`
  - `business_structure_context`
  - `business_structure_context_compact`
- Added compact derivation helper:
  - `_build_business_structure_context_compact()`
- Added merge normalization for all new fields.
- Removed hardcoded Ride Electric canonical context from static prompts so defaults are business-agnostic.

### 2) API schema contract

Updated `backend/src/ghostdash_api/schemas.py`:

- Extended `RuntimeProfileGuardrailsConfig` with new business-structure fields.

Updated `ui/src/api.ts`:

- Extended `RuntimeProfileGuardrailsConfig` TypeScript type with matching fields.

### 3) Ingress behavior

Updated `backend/src/ghostdash_api/agent_ingress.py`:

- Added business-structure helper functions:
  - context sanitization/compaction
  - missing-context question bank resolution
  - capture message detection (`Business structure:`, `Business context:`, etc.)
  - runtime persistence hook (`maybe_bank_business_structure_context`)
  - deterministic missing-context answer builder
- Appended business-structure directives into effective system prompt when context exists.
- Added business-structure compact memory into runtime context block and snapshot id hash input.
- Added pre-plan short-circuit in sync + stream routes:
  - if business-structure gating is enabled and required context is missing for business-performance requests,
    return question-bank answer instead of speculative analysis.

### 4) Agent config UI

Updated `ui/src/pages/AgentConfigPage.tsx`:

- Added editable fields:
  - `Require business structure before analysis`
  - `Business structure question bank`
  - `Business structure memory (editable)`
  - `Business structure compact memory (derived)`
- Wired defaults + payload sanitization for these fields.
- Added validation when gating is enabled and question bank is empty.

## Tests added/updated

- `backend/tests/test_runtime_profiles.py`
  - assert default profile has business-structure defaults
  - assert compact business structure memory is derived on save
- `backend/tests/test_agent_ingress_prompt_hotfix.py`
  - assert business-structure directives are emitted when memory exists
  - assert missing-business-structure answer returns configured question bank

## Test evidence

Executed:

```bash
cd /var/llamaindex/ghoststack-rag && pytest backend/tests/test_runtime_profiles.py backend/tests/test_agent_ingress_prompt_hotfix.py -q
```

Result: `45 passed`

Executed:

```bash
cd /var/llamaindex/ghoststack-rag && pytest backend/tests/test_workflows_odoo_planning.py backend/tests/test_agent_memory_cache_key.py backend/tests/test_odoo_agentic.py -q
```

Result: `39 passed`

## Acceptance criteria

- Business structure is no longer hardcoded to one company set in runtime defaults: **met**
- Business structure is editable in GhostDASH runtime profile UI: **met**
- Missing structure can trigger a deterministic question-bank request: **met**
- Context banking path exists for explicit user-provided structure statements: **met**
- Existing targeted regressions remain green: **met**

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag && pytest backend/tests/test_runtime_profiles.py backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_workflows_odoo_planning.py backend/tests/test_agent_memory_cache_key.py backend/tests/test_odoo_agentic.py -q
```

```bash
cd /var/llamaindex/ghoststack-rag && pytest -q
```
