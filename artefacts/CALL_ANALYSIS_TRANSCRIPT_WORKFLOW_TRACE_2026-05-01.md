# Call Analysis Transcript Workflow Trace Parity — 2026-05-01

## Summary of requirement
- For conversation `conv_4201kqej9eqbetrvfwgnvtk3sjr4`, expose and present the full transcription workflow trace (ASR/LLM/TTS/tool dispatch/tool results/webhook payload context) in a clearer layout.

## Root cause
- Transcript API normalization dropped critical fields (`tool_calls`, `tool_results`, `agent_metadata`, `llm_usage`) so UI could not render detailed workflow/tool execution trace that exists upstream.

## Correct layer
- API normalization layer (`backend/src/ghostdash_api/integrations/elevenlabs_analysis.py`) and transcript UI rendering (`ui/src/pages/ElevenLabsAnalysisPage.tsx`).

## Existing components reused
- Existing transcript endpoint `/api/elevenlabs/analysis/conversations/{conversation_id}/transcript`.
- Existing Call Analysis `Transcription` tab.

## Files changed
- `backend/src/ghostdash_api/schemas.py`
- `backend/src/ghostdash_api/integrations/elevenlabs_analysis.py`
- `ui/src/api.ts`
- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Architecture impact
- Transcript turn schema now carries structured workflow/tool fields.
- UI transcription timeline now renders:
  - role/message/time
  - ASR/LLM/TTS/workflow-route latency chips
  - tool dispatch cards (request + tool details)
  - tool result cards (success/failure + payload)
- No boundary changes; still `/api/*` only.

## Implemented change
- Added transcript turn fields:
  - `agent_metadata`
  - `tool_calls`
  - `tool_results`
  - `llm_usage`
- Mapped those fields from ElevenLabs raw transcript rows.
- Updated TS transcript type to match.
- Upgraded transcription tab layout to a readable timeline with expandable payload blocks.

## Why this is not a static patch
- Fixes canonical transcript contract once so all conversations can render full workflow traces, not just a one-off hardcoded conversation.

## Token/resource impact
- No additional LLM usage.
- Slightly larger transcript payload objects passed to UI.

## Cleanup performed
- No deprecated route or duplicate path introduced.
- Retained existing tabs and behavior while improving transcript detail depth.

## Tests run
- `python3.12 -m compileall backend/src`
- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
- `docker compose up -d --build control-api ui`
- `curl -sS -o /dev/null -w '%{http_code}\n' https://ghoststack.rideai.com.au/analysis/call-analysis`
- Remote transcript contract check for target conversation.

## Test output
- Backend compile passed.
- UI lint/build passed.
- `control-api` and `ui` rebuilt and started.
- Remote Call Analysis route returned `200`.
- Transcript endpoint now returns `tool_calls` and `tool_results` for the target conversation.

## Manual human verification
1. Open `https://ghoststack.rideai.com.au/analysis/call-analysis/conv_4201kqej9eqbetrvfwgnvtk3sjr4`.
2. Open `Transcription` tab.
3. Verify timeline cards show ASR/LLM/TTS/workflow latencies where present.
4. Expand `Show request` and `Show result payload` on tool cards.
5. Confirm hubtiger workflow/tool result trace is visible and readable.

## Known risks
- Very large tool result payloads can still be long; now mitigated with collapsible sections.
