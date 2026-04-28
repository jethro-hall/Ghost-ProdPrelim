# Provider model-not-found incident (2026-04-17)

## Symptom

Chat UI returned a generic provider failure bubble:

- "The provider reported an error. Review the message bubble details or switch to mock mode for UI testing."

## Root cause

`agent-ingress` logs showed repeated upstream 404 model errors:

- `The model 'gpt-4o-mini' does not exist`
- `The model '/llama31-8b' does not exist`

Primary cause: several agents using the `RideAILLM` OpenAI-compatible connection stored malformed model IDs (`/llama31-8b`, `model/LLAMA31-8B`, `LLAMA31-8B`).

## Immediate production fix applied

Updated affected agents (connection id `da5d2c35-5024-43ee-a08a-9e8584c726f5`) to:

- `model_id = llama31-8b`

Agents updated:

- `JH - Finance`
- `Finance Agent`
- `GPT-5 Data Collector`
- `Boy Genius`

## Code hardening added

File: `backend/src/ghostdash_api/runtime.py`

Updated `_normalize_provider_model_id()` for OpenAI-family providers to:

- strip `openai/` prefix
- strip `model/` prefix
- strip leading `/`
- normalize all-caps model IDs to lowercase

This prevents persisted malformed IDs from causing runtime outages.

## Regression tests

File: `backend/tests/test_runtime_profiles.py`

Added:

- `test_normalize_model_id_strips_slash_and_model_prefix_for_openai_provider`

## Verification

```bash
cd /var/llamaindex/ghoststack-rag/backend
pytest tests/test_runtime_profiles.py -q
pytest tests/test_agent_ingress_prompt_hotfix.py -q
```

Result:

- `9 passed`
- `14 passed`
