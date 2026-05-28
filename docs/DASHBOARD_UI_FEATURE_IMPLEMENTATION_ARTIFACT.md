## Dashboard UI Feature Implementation Artifact

### Source instructions used

This implementation was derived from the repo Markdown guidance in:

- [`docs/GHOSTDASH_UI_ARCHITECTURE.md`](../docs/GHOSTDASH_UI_ARCHITECTURE.md)
- [`docs/ARCHITECTURE_V2.md`](../docs/ARCHITECTURE_V2.md)
- [`docs/HANDOFF.md`](../docs/HANDOFF.md)

### Why this slice was chosen

The current dashboard already covered a partial Phase 1 capability surface, but it did not yet fully reflect the documented operator-facing requirements:

- surface active provider/model/runtime choices on the dashboard
- show richer runtime capability visibility
- show recent document ingestion state directly on the dashboard

Those features were explicitly called out in the docs and could be implemented cleanly without inventing new backend contracts.

### Implemented UI changes

Updated [`ui/src/pages/Dashboard.tsx`](../ui/src/pages/Dashboard.tsx) to add:

1. Expanded capability cards
   - local parser lane readiness
   - cloud parser lane readiness
   - chat API mode readiness
   - streaming readiness
   - vector store + model runtime identity

2. Active runtime/provider panel
   - active provider label
   - provider base URL
   - persisted chat API mode from `/api/runtime/defaults`
   - active chat model
   - active embedding model
   - runtime identity summary

3. Recent document ingestion state
   - filename
   - requested lane
   - actual parse lane
   - parse/index badge state
   - workbook sheet/table/row counts when present
   - inline document error message when present

### API contracts used

No new backend endpoints were introduced. The dashboard uses existing endpoints:

- `GET /api/capabilities`
- `GET /api/connections`
- `GET /api/runtime/defaults`
- `GET /api/documents`
- `GET /api/runs`

### Verification

Build verification:

```bash
docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run build"
```

Result:

- build passed

### Notes

- I treated `docs/HANDOFF.md` as the authoritative live-state reference when doc wording conflicted with older architecture text.
- I did not change chat routing or add new backend fields because the existing contracts were already sufficient for the requested dashboard slice.
