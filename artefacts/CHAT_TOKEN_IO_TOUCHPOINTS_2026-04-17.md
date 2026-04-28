# Chat Token I/O Touchpoints (2026-04-17)

## Objective

Expose per-turn LLM token accounting at the chat surface with explicit directional metrics:

- Input tokens (prompt side)
- Output tokens (completion side)
- Total tokens
- First and last text slices from the final prompt sent to the LLM

This complements existing conversation-level totals and improves prompt-size debugging when guardrails reject oversized inputs.

## Backend contract update

File: `backend/src/ghostdash_api/agent_ingress.py`

### What changed

1. Added `_normalize_prompt_excerpt()` to collapse multiline prompt text into single-line, UI-safe excerpts.
2. Added `_build_llm_io_payload()` to emit a stable per-turn payload:
   - `input_tokens`
   - `output_tokens`
   - `total_tokens`
   - `input_first_text`
   - `input_last_text`
3. In stream flow (`/agent/chat/stream`), after `usage_stream` resolution:
   - Build `llm_io_payload`
   - Include it in SSE `done` event under `llm_io`

### Why this shape

- Existing `usage` object remains unchanged for compatibility with non-stream and persisted usage assertions.
- New directional data is additive and stream-only, reducing regression risk.

## Frontend contract update

Files:

- `ui/src/api.ts`
- `ui/src/hooks/useChatEngine.ts`
- `ui/src/pages/chat/ChatArea.tsx`
- `ui/src/pages/chat/MessageList.tsx`
- `ui/src/components/GhostChat.tsx`

### API typing

`LlmIoPayload` added and wired into `streamChat` done payload parsing as optional `llm_io`.

### Chat state wiring

In both chat engines (`useChatEngine` and `GhostChat`):

- `ChatEntry` now carries optional `usage` and `llmIo`
- Added `deriveLlmIoFromUsage()` fallback for historical/persisted messages
- `onDone` binds `llm_io` from stream into assistant message
- Added `lastLlmIo` state for “latest turn” summary in header

### UI presentation

- Header now shows latest turn directional counters (IN/OUT/TOTAL)
- Message bubbles show per-turn counters
- When available, first/last prompt excerpts are rendered for fast debugging

## Verification performed

1. Backend regression suite:
   - `pytest backend/tests/test_agent_ingress_prompt_hotfix.py`
   - Result: pass (13/13)
2. UI type-check:
   - `./ui/node_modules/.bin/tsc --noEmit -p ui/tsconfig.json`
   - Result: pass

## Operational notes

- This does not change provider billing counters; values are existing usage estimates/provider values already in the pipeline.
- Prompt excerpts are intentionally compacted and whitespace-normalized to avoid dumping large hidden context blocks into UI.
