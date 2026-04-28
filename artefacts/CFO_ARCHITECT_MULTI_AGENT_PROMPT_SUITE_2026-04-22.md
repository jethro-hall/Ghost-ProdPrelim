# CFO Architect Multi-Agent Prompt Suite (2026-04-22)

## Objective

Upgrade GhostDASH finance orchestration from a generic strategist persona to a **Group CFO Architect** lead pattern with explicit sub-agent roles:

1. Case Framing Agent
2. Evidence Retrieval Agent
3. Odoo Specialist
4. Reasoning / Synthesis Agent
5. Documentation / Apryse Document Generator Agent

## Implemented

### 1) Lead prompt upgraded

Updated `backend/src/ghostdash_api/runtime_profiles.py`:

- Replaced `BUSINESS_STRATEGIST_SYSTEM_PROMPT` with a CFO-architect lead prompt that enforces:
  - diagnostics + forecasting + fix prioritization
  - explicit sub-agent orchestration responsibilities
  - Odoo grounding override and truth contract
  - board-ready output structure
  - AUD and financial formatting standards

### 2) Sub-agent prompt suite added

Added new prompt constants in `backend/src/ghostdash_api/runtime_profiles.py`:

- `CASE_FRAMING_AGENT_SYSTEM_PROMPT`
- `EVIDENCE_RETRIEVAL_AGENT_SYSTEM_PROMPT`
- `REASONING_SYNTHESIS_AGENT_SYSTEM_PROMPT`

Also hardened existing prompts:

- `ODOO_SPECIALIST_SYSTEM_PROMPT` now explicitly flags Odoo integrity defects.
- `APRYSE_DOCX_SYSTEM_PROMPT` reinforced for CFO-grade board-ready output quality.

### 3) Seeded finance sub-agent stack

Updated `backend/src/ghostdash_api/agent_memory.py` `special_agent_payloads()`:

- Updated Business Strategist first message and runtime description to CFO Architect framing.
- Added sub-agents under `Business Strategist` parent:
  - `[SA] Finance Case Framing Agent`
  - `[SA] Evidence Retrieval Agent`
  - `[SA] Reasoning / Synthesis Agent`
  - `[SA] Odoo Specialist`
  - `[SA] Documentation / Apryse Document Generator Agent`

### 4) Structured workflow helper prompts aligned

Updated `backend/src/ghostdash_api/agent_builds.py`:

- `case_framing_prompt(...)` now aligns to CFO-orchestration framing constraints.
- `evidence_retrieval_prompt(...)` now enforces stronger evidence-only contract and source fidelity.

## Test evidence

Executed:

```bash
cd /var/llamaindex/ghoststack-rag && pytest backend/tests/test_runtime_profiles.py backend/tests/test_agent_seed_persistence.py backend/tests/test_agent_builds.py -q
```

Result: `16 passed`

## Acceptance criteria

- Lead finance agent prompt is CFO-architect oriented: **met**
- Prompts exist for all requested sub-agent functions: **met**
- Finance orchestration seed includes requested sub-agent types under lead: **met**
- Regression tests for runtime profile + seed + prompt contracts pass: **met**

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag && pytest backend/tests/test_runtime_profiles.py backend/tests/test_agent_seed_persistence.py backend/tests/test_agent_builds.py -q
```

```bash
cd /var/llamaindex/ghoststack-rag && pytest -q
```
