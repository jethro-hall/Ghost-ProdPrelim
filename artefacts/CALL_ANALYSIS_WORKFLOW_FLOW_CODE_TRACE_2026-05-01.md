# Call Analysis Workflow Flow + Code Trace Clarity — 2026-05-01

## Summary of requirement
- Make workflow data explicit and easy to follow, including flow order and what code was executed.

## Root cause
- Existing workflow presentation emphasized normalized call cards but did not clearly sequence transcript workflow events (route -> dispatch -> result) with code execution labels.

## Correct layer
- Frontend workflow renderer in `ui/src/pages/ElevenLabsAnalysisPage.tsx`.

## Existing components reused
- Existing transcript endpoint with `tool_calls` and `tool_results`.
- Existing `Workflow` tab and glass panel styling.

## Files changed
- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Architecture impact
- No backend/API changes.
- Workflow tab now builds a timeline from transcript events and displays route/dispatch/result in execution order.

## Implemented change
- Added transcript-derived workflow flow model (`WorkflowFlowStep`) with:
  - step kind (`speech`, `route`, `tool_dispatch`, `tool_result`)
  - timestamp label
  - latency chip
  - status badge
  - code executed hint
  - request/result payload blocks
- Added code-executed detection from payload fields:
  - `function`
  - `nested_tools`
  - `operation` / `data.operation`
- Workflow tab now surfaces:
  - `Flow steps` count
  - ordered execution cards
  - collapsible request/result JSON payloads

## Why this is not a static patch
- Uses generalized transcript event parsing so all conversations with workflow tools gain the same visibility rather than one hardcoded conversation.

## Token/resource impact
- No additional LLM usage.
- Minimal client-side parsing/render overhead.

## Cleanup performed
- Retained existing normalized `workflowCalls` section for compatibility while adding clearer execution timeline above it.

## Tests run
- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
- `docker compose up -d --build ui`
- `curl -sS -o /dev/null -w '%{http_code}\n' https://ghoststack.rideai.com.au/analysis/call-analysis`
- Transcript workflow event count check for `conv_4201kqej9eqbetrvfwgnvtk3sjr4`.

## Test output
- TypeScript lint/build passed.
- UI service rebuilt and started.
- Remote route returned `200`.
- Target transcript contains workflow evidence (`tool_call_turns=3`, `tool_result_turns=3`).

## Manual human verification steps
1. Open `https://ghoststack.rideai.com.au/analysis/call-analysis/conv_4201kqej9eqbetrvfwgnvtk3sjr4`.
2. In right pop-out panel, open `Workflow` tab.
3. Confirm ordered flow cards for route, tool dispatch, and tool result.
4. Confirm `Code executed` appears when function/operation can be detected.
5. Expand request/result payload blocks and validate webhook/tool context readability.

## Known risks
- Some workflow steps may lack a direct function/operation field; those cards correctly omit `Code executed` rather than guessing.
