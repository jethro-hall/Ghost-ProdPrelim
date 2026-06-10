# Call Analysis CSV Export (Top-Left EXPORT Button)

## Scope
- Added a top-left `EXPORT` button in the Conversations panel on the call analysis page.
- Export now fetches **all paginated records** for active filters (not just the current page).
- CSV is generated with strict quoting/escaping and downloaded in-browser.

## Files Changed
- `ui/src/pages/ElevenLabsAnalysisPage.tsx`

## Implementation Notes
- Introduced `csvValue()` for strict CSV escaping:
  - All fields are double-quoted.
  - Internal quotes are escaped as `""`.
  - Objects/arrays are serialized with `JSON.stringify`.
- Introduced `downloadCsv()` to build a Blob and trigger browser download.
- Added `exportingCsv` UI state to prevent duplicate exports and show progress.
- Added `exportAllToCsv()`:
  - Iterates through every conversation page using cursors.
  - Applies current filters (`search`, `status`, `date_after`, `date_before`) consistently.
  - For each conversation, fetches detail + transcript and exports expanded columns.
  - Captures per-row `export_error` if a row-level detail fetch fails.
  - Saves as `call-analysis-export-<timestamp>.csv`.

## Exported Columns
- Summary fields: ids, title, status, call metadata, agent/caller metadata.
- Detail fields: environment, call status/summary, termination, cost/credits.
- Derived fields: user data captured, workflow call count, transcript turn count.
- JSON payload fields: metadata, analysis, client data, tag ids, visited agents.
- Reliability field: `export_error`.

## Field Dictionary (All CSV Columns)
- `id` (string): Conversation identifier from conversation summary.
- `title` (string|null): Conversation title from summary.
- `status` (string): Conversation processing/result status from summary.
- `call_successful` (string): Upstream success marker from summary payload.
- `started_at_unix_secs` (number|null): Conversation start time in unix seconds.
- `started_at_iso` (string): ISO-8601 UTC timestamp derived from `started_at_unix_secs`; empty when unavailable.
- `duration_seconds` (number|null): Total call duration from summary.
- `message_count` (number|null): Summary-reported number of message entries.
- `user_id` (string|null): Caller/user identifier from summary/detail.
- `branch_id` (string|null): Branch identifier from summary filters/source.
- `main_language` (string|null): Primary language reported by upstream.
- `channel` (string|null): Call channel from summary (if present).
- `direction` (string|null): Call direction from summary (if present).
- `rating` (number|null): Conversation rating from summary.
- `agent_id` (string|null): Agent identifier attached to the conversation.
- `agent_name` (string|null): Agent display name attached to the conversation.
- `environment` (string|null): Runtime environment from conversation detail.
- `call_status` (string|null): Detailed call status from conversation detail.
- `call_summary_title` (string|null): Upstream call summary title.
- `transcript_summary` (string): Detail transcript summary when available, else derived transcript summary.
- `termination_reason` (string|null): Reason call ended, from detail payload.
- `has_audio` (boolean|string): Whether call audio exists. On row-level fetch error this is blank.
- `has_user_audio` (boolean|string): Whether user channel audio exists. Blank when row-level fetch fails.
- `has_response_audio` (boolean|string): Whether assistant channel audio exists. Blank when row-level fetch fails.
- `cost` (number|string|null): Call cost from detail payload; blank on row-level export failure.
- `credits_llm` (number|string|null): LLM credits usage from detail payload; blank on row-level export failure.
- `llm_cost` (number|string|null): LLM-specific cost from detail payload; blank on row-level export failure.
- `user_data_captured` (string): Pipe-delimited extracted captures (e.g. name/number/job hints) from transcript + tool results.
- `workflow_call_count` (number|string): Count of normalized workflow/tool calls derived from detail payload; blank on row-level fetch failure.
- `transcript_turn_count` (number|string): Number of transcript turns for the conversation; blank on row-level fetch failure.
- `metadata_json` (json-string|string): Raw detail metadata object serialized to JSON text for strict CSV.
- `analysis_json` (json-string|string): Raw detail analysis object serialized to JSON text for strict CSV.
- `client_data_json` (json-string|string): Raw detail client data object serialized to JSON text for strict CSV.
- `tag_ids_json` (json-string|string): Tag ID list serialized as JSON text.
- `visited_agents_json` (json-string|string): Visited agent entries serialized as JSON text.
- `export_error` (string): Row-level export error message if detail/transcript fetch fails; otherwise empty.

## CSV Strictness Rules
- Every field is enclosed in double quotes.
- Embedded double quotes are escaped as doubled quotes (`""`).
- Row delimiter is CRLF (`\r\n`) for broad spreadsheet compatibility.
- Non-scalar fields (objects/arrays) are JSON-stringified before quoting.
- Null/undefined values are exported as empty quoted fields (`""`).

## Validation Performed
- `ReadLints` for changed file: no lint diagnostics.
- `npm run lint` in `ui`: passed (`tsc --noEmit`).
- `npm run build` in `ui`: failed due filesystem permissions in `dist` cleanup (`EACCES` unlink on existing asset), not a TypeScript/runtime code regression.

## Human Test Checklist (E2E)
1. Open `https://ghoststack.rideai.com.au/analysis/call-analysis`.
2. Confirm `EXPORT` appears at top-left of the Conversations section.
3. Click `EXPORT` with no filters.
4. Confirm a CSV download starts and filename pattern is `call-analysis-export-<timestamp>.csv`.
5. Open CSV and verify:
   - Header includes all expected columns.
   - Rows include historical pages (more than current page count where applicable).
   - JSON fields are properly quoted.
   - Embedded quotes in text are escaped as doubled quotes.
6. Apply filters (search/status/date), export again, and confirm only filtered data is present.
7. Inspect `export_error` column for any row-level fetch issues.

## Suggested Fix For Build Permission Blocker
- Ensure the `ui/dist` directory is writable by the current user before running `npm run build`.
