# Call Analysis User Data Accuracy + TITLE Column — 2026-05-01

## Summary of requirement
- Improve user-data capture accuracy to match overview-level detail (example includes `Ian LeGarth` for `conv_1601kqerjmsxehfbytxgz884kcrv`).
- Add explicit `TITLE` field as first column in Analysis conversation list.

## Root cause
- Previous list enrichment relied mostly on lightweight transcript heuristics and could miss canonical identifiers available in detail analysis summary/tool outputs.

## Correct layer
- Frontend enrichment logic in `ui/src/pages/ElevenLabsAnalysisPage.tsx`.

## Existing component reused
- Existing detail endpoint `fetchElevenLabsAnalysisConversation()`.
- Existing transcript endpoint `fetchElevenLabsAnalysisTranscript()`.
- Existing conversation table and enrichment state.

## Files changed
- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Architecture impact
- No backend contract changes required for this fix.
- Frontend now enriches each list row with detail + transcript in parallel and prefers canonical summary fields.

## Implemented change
- Enrichment now fetches:
  - conversation detail (`transcript_summary`, `call_summary_title`, `user_id`)
  - transcript turns (including tool results already exposed)
- Summary priority now:
  1. `detail.transcript_summary`
  2. `detail.call_summary_title`
  3. fallback transcript summarizer
- User-data capture now combines:
  - canonical detail summary parsing (quoted names, `for <Name>` patterns, numbers)
  - user utterance extraction
  - tool-result extraction (`identified_customer`, `identifier_value`, `job_card_no`)
- Added/renamed first list column header to `TITLE`.

## Why this is not a static patch
- Uses canonical detail data path first, then transcript/tool-derived fallbacks; this generalizes across conversations instead of one hardcoded conversation fix.

## Token/resource impact
- No LLM token increase.
- Same class of API load as existing enrichment, but now includes detail fetch per row for stronger accuracy.

## Cleanup performed
- Replaced old transcript-only summary/capture strategy with merged detail+transcript strategy.
- Preserved existing list/table interactions and paging.

## Tests run
- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
- `docker compose up -d --build ui`
- Remote route check for target conversation page.
- Detail summary verification for target conversation.

## Test output
- UI lint passed.
- UI build passed.
- UI service rebuilt and started.
- Conversation route returned HTTP `200`.
- Detail endpoint for target conversation confirms transcript summary includes `Ian LeGarth`.

## Manual human verification steps
1. Open `https://ghoststack.rideai.com.au/analysis/call-analysis/conv_1601kqerjmsxehfbytxgz884kcrv`.
2. In conversation list, confirm first header is `TITLE`.
3. Confirm list `Transcript summary` reflects overview-level summary detail (including named entity context where available).
4. Confirm `User data captured` includes customer name/number/job-card context when present.

## Known risks
- Entity extraction from free text remains deterministic pattern-based; uncommon name formats may still need additional parsing rules.
