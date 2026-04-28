## Multi-LLM fallback provider length fix (2026-04-18)

### Incident
- Saving a new agent with multi-LLM enabled failed validation:
  - `body.runtime_profile.llm_config.llm_orchestration.fallback_provider: String should have at most 64 characters`

### Observed behavior
- UI accepted arbitrary text in `Fallback provider key`.
- Backend validates `fallback_provider` with `max_length=64` even when `fallback_connection_id` is set.
- If an oversized value lands in `fallback_provider`, agent save fails before runtime profile persistence.

### Root cause
- Client-side save normalization forwarded raw `fallback_provider` without a hard guard.
- `fallback_provider` remained user-editable while a `fallback_connection_id` was selected, despite runtime behavior primarily using `fallback_connection_id`.

### Changes implemented
- File: `ui/src/pages/AgentConfigPage.tsx`
  - In `normalizeDraftForSave()`:
    - Normalize `fallback_connection_id` once.
    - Derive `fallback_provider` deterministically:
      - If fallback connection is selected, inherit from primary `llm_config.provider`.
      - Else use trimmed manual `fallback_provider` (or `openai` default).
    - Hard cap serialized `fallback_provider` to 64 chars before request payload submission.
  - In the fallback provider input:
    - Added `autoComplete="off"` to reduce accidental credential autofill.
    - Added `maxLength={64}` to align UI input constraints with backend schema.
    - Updated copy to `Fallback provider id (not API key)` and placeholder `e.g. openai`.

### Why this is safe
- Preserves current runtime contract:
  - Connection-selected fallback path continues to prefer connection identity.
  - Provider-key fallback path remains available when no fallback connection is set.
- Removes validation mismatch between UI and API contract.
- Adds defensive normalization without touching backend persistence logic.

### Verification plan
1. In Agent Configuration, create a new agent.
2. Enable multi-LLM orchestration.
3. Select a fallback connection.
4. Paste a long string (>64 chars) into `Fallback provider key`.
5. Save agent.
6. Expected: save succeeds; no `fallback_provider` max-length validation error.
7. Optional: clear fallback connection, set a short provider key (for example `openai`), save again.

### Acceptance criteria
- New agent save no longer fails with `fallback_provider` max-length error when multi-LLM is enabled.
- UI prevents entering more than 64 characters for `Fallback provider key`.
- Serialized payload keeps `fallback_provider` schema-compliant.
