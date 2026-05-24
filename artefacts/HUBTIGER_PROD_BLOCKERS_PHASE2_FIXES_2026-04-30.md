# Hubtiger Production Blockers - Phase 2 Fixes (2026-04-30)

## Requirement

Fix the five blockers from production-readiness review:

1. Exact job-card retrieval over-blocking on store mismatch.
2. Truncated broad-search responses losing actionable envelope.
3. Weak numeric identifiers (`1234`) silently treated as job cards.
4. Store handling unable to distinguish unknown vs mismatch.
5. Availability/quote upstream failures lacking clear fallback categorization.

## Implemented fixes

### 1) Exact identifier no longer over-blocks

- Added identifier context fields: `identifier_type`, `identifier_confidence`.
- For single exact `job_card_no` or `job_id` match with `store_verification=unknown`, response now allows:
  - `selection_required=false`
  - no forced store clarification action.

### 2) Truncation keeps decision envelope

When payload size requires truncation for job operations, response now preserves:

- `count`
- `selection_required`
- `assistant_prompt`
- `allowed_next_actions`
- store and identifier metadata

instead of returning only a generic `truncated` marker.

### 3) Weak identifier coercion prevented

- Added identifier disambiguation for ambiguous numeric inputs (e.g. `1234`).
- For weak numeric/name-partial inputs in `job_search`/`job_lookup`, API returns clarification envelope instead of querying as implicit job card.

### 4) Store semantics split into explicit states

Added `store_verification`:

- `matched`
- `mismatch`
- `unknown`
- `not_requested`

`store_match` is now nullable (`true`/`false`/`null`) to avoid treating unknown as mismatch.

### 5) Upstream fallback clarity for availability/quote

Upstream failures now include operation-specific error codes and messages:

- `availability_lookup_unavailable_upstream`
- `quote_preview_unavailable_upstream`

with controlled customer-safe fallback wording.

## Difficult-mode validation snapshots

### First-name-only (previously regressed)

- Now returns clarification envelope:
  - `selection_required=true`
  - `assistant_prompt` asks for stronger identifier
  - no useless `truncated-only` response

### Exact `#35872` retrieve

- Returns single case with:
  - `identifier_confidence=exact`
  - `store_verification=unknown`
  - `selection_required=false`

### Weak `1234` query

- Now returns ambiguity prompt:
  - `identifier_type=ambiguous_numeric`
  - asks whether `1234` is job card or phone fragment.

## Files changed

- `backend/src/ghostdash_api/hubtiger_mcp.py`
- `backend/src/ghostdash_api/integrations/hubtiger_elevenlabs_tool.py`
- `backend/tests/test_hubtiger_mcp_adapter.py`
- `backend/tests/test_hubtiger_elevenlabs_tool.py`
- `docs/HUBTIGER_OPERATOR_PLAYBOOK.md`
- `docs/HUBTIGER_ELEVENLABS_TOOL_SCHEMA_PROMPT_PACK.md`

## Tests run

```bash
python3.12 -m pytest tests/test_hubtiger_elevenlabs_tool.py tests/test_hubtiger_mcp_adapter.py
node --test services/hubtiger-mcp/index.test.js
```

Results:

- Python: `22 passed, 1 warning`
- Node: `10 passed, 0 failed`
