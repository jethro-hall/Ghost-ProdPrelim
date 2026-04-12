# RideAI `llama31-8b` GhostDASH Integration

## Goal

Switch GhostDASH to the RideAI LlamaIndex gateway model `llama31-8b` and make the OpenAI-compatible runtime work with the gateway's required `X-Internal-Key` header.

## What Changed

- Added base URL normalization so GhostDASH accepts either the OpenAI-compatible `/v1` root or an accidentally pasted `/chat/completions` endpoint and still uses the correct root.
- Added automatic `X-Internal-Key` header injection for the RideAI gateway host `one.rideai.com.au/api/llamaindex/v1`.
- Added a direct OpenAI-compatible chat-completions adapter for the RideAI gateway to bypass LlamaIndex OpenAI model-name validation that rejects non-OpenAI IDs like `llama31-8b`.
- Updated live GhostDASH connection state to use:
  - provider: `openai`
  - label: `RideAILLM`
  - base URL: `https://one.rideai.com.au/api/llamaindex/v1`
- Updated live runtime profiles:
  - `GhostDASH Default Runtime`
  - `Finance Agent Runtime`
  - model: `llama31-8b`
  - api mode: `chat_completions`
- Updated new-agent defaults so the UI does not drift back to `openai/gpt-5.4`.

## Verification

- Targeted regression tests passed for:
  - RideAI base URL normalization
  - RideAI `X-Internal-Key` header injection
- Live GhostDASH provider test passed:
  - model: `llama31-8b`
  - base URL: `https://one.rideai.com.au/api/llamaindex/v1`
  - response body returned expected confirmation

## Important Residual Blocker

The full `/agent/chat` request path is still blocked by an existing Qdrant vector-size mismatch in `workflow-runtime`, not by the model integration:

- configured collection: `ghostdash_knowledge`
- collection vector size: `1536`
- GhostDASH configured vector size: `1024`

This needs either:

1. a clean Qdrant collection aligned to the current embedding size, or
2. `APP_QDRANT_VECTOR_SIZE` aligned to the existing collection and embedding model.

Until that is corrected, live retrieval-backed chat requests can fail before they reach final answer generation.
