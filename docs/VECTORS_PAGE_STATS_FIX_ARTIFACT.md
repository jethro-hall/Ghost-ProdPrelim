## Vectors Page Stats Fix Artifact

### Problem

The `/vectors` page, and by extension the top-level operator mental model, were showing misleading numbers for:

- Documents with tracked state
- Retrieval artifacts surfaced
- Structured workbook rows

Root causes:

1. The page read from `GET /api/documents`, which is intentionally limited to the latest 50 documents.
2. The page used `document.artifacts.length`, which counts unique artifact types per document, not total retrieval artifacts.
3. The page summed row counts only across that same 50-document window.

That made the screen look stuck and materially understated the live collection size.

### Fix

Added a dedicated aggregate endpoint:

- `GET /api/vector-stats`

This endpoint returns authoritative totals directly from the database:

- `documents`
- `retrieval_artifacts`
- `workbook_rows`

Updated:

- `backend/src/ghostdash_api/control_api.py`
- `backend/src/ghostdash_api/schemas.py`
- `ui/src/api.ts`
- `ui/src/pages/Dashboard.tsx`
- `ui/src/pages/VectorsPage.tsx`

The `/vectors` page now uses the aggregate endpoint instead of deriving totals from the paged document list, and the dashboard now explicitly labels aggregate totals versus the capped recent-documents preview.

### Why this is correct

- It separates operator totals from paged document listings.
- It makes the page O(1) in UI complexity instead of requiring a full document payload.
- It avoids conflating artifact types with artifact counts.
- It removes the 50-document cap from the monitoring surface.

### Verification

Authoritative Postgres totals:

- documents: `89`
- retrieval_artifacts: `215859`
- workbook_rows: `202021`

Old page math from `GET /api/documents`:

- documents_len: `50`
- artifact_type_sum: `79`
- workbook_row_sum: `103691`

Live API after fix:

- `GET /api/vector-stats` returned:
  - `{"documents":89,"retrieval_artifacts":215859,"workbook_rows":202021}`

Browser verification after rebuild:

- `/` loaded cleanly
- dashboard showed:
  - `89` aggregate tracked files
  - copy explaining that `/api/vector-stats` is authoritative and the recent-documents panel is a capped preview
- `/vectors` loaded cleanly
- page showed:
  - `89`
  - `215859`
  - `202021`
- page also showed the file-type breakdown:
  - `31` PDF
  - `55` XLSX/XLSM
  - `2` TXT-like
  - `1` other
- counters were no longer stuck on the old values

### Acceptance criteria

- `/vectors` no longer depends on the 50-row `/api/documents` list: met
- dashboard aggregate totals are clearly separated from the capped recent-documents preview: met
- retrieval artifact count reflects real artifact rows, not artifact type count: met
- live UI matches authoritative database totals: met

### Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag
curl -sS http://localhost/api/vector-stats
docker exec ghoststack-rag-postgres-1 psql -U ghostdash -d ghostdash -At -F $'\t' -c "select (select count(*) from documents), (select count(*) from retrieval_artifacts), (select count(*) from workbook_rows);"
python3.12 - <<'PY'
import json, urllib.request
rows = json.loads(urllib.request.urlopen('http://localhost/api/documents', timeout=120).read().decode())
print(json.dumps({
  'documents_len': len(rows),
  'artifact_type_sum': sum(len(row.get('artifacts', [])) for row in rows),
  'workbook_row_sum': sum(row.get('workbook_row_count', 0) for row in rows),
}, indent=2))
PY
```
