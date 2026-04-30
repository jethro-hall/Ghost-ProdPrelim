# Hubtiger ElevenLabs Tool Schema + Prompt Pack (2026-04-30)

## Requirement

Provide a single copy/paste pack for ElevenLabs that includes both:

1. Tool schema contract for Hubtiger tool calls.
2. Prompt instructions enforcing deterministic workflow and customer-safe output.

## Root Cause

Workflow guidance existed, but implementation teams still had to assemble schema and prompt text from multiple documents, which increases integration drift.

## Correct Layer

- Operator/integration documentation (`docs/`)

## Existing Components Reused

- `backend/src/ghostdash_api/schemas.py` (`ElevenLabsHubTigerToolRequest`, `PublicToolResult`)
- `backend/src/integrations/elevenlabs_hubtiger/router.py` (canonical bridge route)
- `docs/HUBTIGER_OPERATOR_PLAYBOOK.md` (workflow and guardrail behavior)

## Change Implemented

Created:

- `docs/HUBTIGER_ELEVENLABS_TOOL_SCHEMA_PROMPT_PACK.md`

Content includes:

- endpoint/auth contract
- JSON schema for ElevenLabs tool parameters
- deterministic function routing rules
- copy/paste prompt block
- ready request examples
- quick QA checklist

## Why This Is Not A One-Off

This consolidates integration truth into one pack and reduces repeated manual translation, keeping ElevenLabs setup aligned with current Hubtiger runtime behavior.

## Tests / Proof

Docs verification commands:

```bash
rg "Tool endpoint contract|ElevenLabs tool schema|Prompt pack" docs/HUBTIGER_ELEVENLABS_TOOL_SCHEMA_PROMPT_PACK.md
rg "\"function\": \"job_search\"|\"function\": \"job_retrieve\"|\"function\": \"booking_availability\"|\"function\": \"quote_preview\"" docs/HUBTIGER_ELEVENLABS_TOOL_SCHEMA_PROMPT_PACK.md
```

## Human QA

1. Copy the schema block into ElevenLabs custom tool setup.
2. Copy the prompt pack block into agent instructions.
3. Run one existing-job two-step call (`job_search` then `job_retrieve`).
4. Confirm response remains concise and customer-safe.
