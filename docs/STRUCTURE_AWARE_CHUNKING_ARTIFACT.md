## Structure-Aware Chunking Artifact

### Goal

Advance the GhostDASH retrieval path from blind character slicing toward structure-aware chunking, while keeping the existing Postgres + Qdrant runtime shape intact.

### Problem

Before this change, generic text ingestion relied on simple fixed slicing in `persist_text_retrieval_artifacts()`:

- chunks were created by raw character windows
- markdown and headed text lost section boundaries
- `section_title` metadata was only strong on the PDF path
- cloud markdown workbook artifacts were stored as a single large retrieval record instead of chunked retrieval units

That meant retrieval quality and citations for non-PDF text were weaker than they needed to be.

### Implemented change

Updated `backend/src/ghostdash_api/workflows.py` to:

1. Chunk text on structural boundaries where possible
   - prefer breaks on paragraph and sentence boundaries before falling back to plain whitespace

2. Detect and preserve sections for headed text
   - markdown headings such as `# Overview`
   - standalone uppercase headings where present

3. Persist section-aware metadata on every text chunk
   - `section_title`
   - `section_path`
   - `heading_level`
   - `section_index`
   - `section_chunk_index`
   - `chunk_index`
   - `token_count`

4. Chunk `llamaparse_markdown` workbook artifacts instead of storing one large retrieval blob
   - this keeps cloud markdown enrichment aligned with the same retrieval contract

5. Fix retrieval citation consistency
   - `chunk_index` is now carried at the top-level Qdrant payload
   - `section_path` and `heading_level` are now carried through Qdrant search hits and semantic citations
   - Qdrant search also falls back to nested metadata for older indexed payloads

### Files changed

- `backend/src/ghostdash_api/workflows.py`
- `backend/src/ghostdash_api/qdrant_store.py`
- `backend/tests/test_ingestion_qdrant_batching.py`

### Final hardening in this pass

After the initial in-flight implementation, this pass closed the remaining ship blockers:

1. Fixed the focused structure-aware test
   - `persist_text_retrieval_artifacts()` now gets the explicit `chunk_size`, `chunk_overlap`, and `heading_aware` arguments that the function actually requires

2. Completed semantic citation propagation
   - `build_query_plan()` now includes:
     - `section_title`
     - `section_path`
     - `heading_level`
   - this keeps live chat citations aligned with the `ChatCitation` schema instead of dropping the newly stored heading metadata on the semantic path

3. Completed Qdrant hit compatibility
   - `search_vectors()` now exposes `section_path` and `heading_level` directly on the hit object while still supporting nested metadata fallback

### Why this is fit for purpose

- It improves retrieval quality without replacing the current stack.
- It reuses the existing metadata contract rather than inventing a second artifact format.
- It upgrades non-PDF retrieval toward the same provenance quality already present in the PDF path.
- It keeps ingestion deterministic and operationally inspectable.

### Verification performed

Repo/runtime state checked first:

- `git status -sb`
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'`

Code validation:

- `python3.12 -m compileall backend/src`
- `python3.12 -m compileall backend/src/ghostdash_api/workflows.py backend/src/ghostdash_api/qdrant_store.py`
- focused editor diagnostics on the touched files: passed

Focused test note:

- direct host-side `pytest` collection was blocked because the host Python environment does not have the backend package dependencies installed (for example `tiktoken`)
- the standard app image also does not include `pytest` or repo test files, so focused verification for this pass used:
  - compile checks on the edited modules
  - inline Python assertions inside the rebuilt backend container
  - live chat/UI smoke testing on the running stack

Live verification:

1. Rebuilt `workflow-runtime`
2. Rebuilt `control-api` and `agent-ingress` so the running stack picked up the updated citation/Qdrant code
3. Ran inline container assertions covering:
   - `build_qdrant_payload()`
   - `persist_text_retrieval_artifacts()`
   - `build_query_plan()`
4. Confirmed those assertions passed against the rebuilt runtime dependencies
5. Queried `/agent/chat` and confirmed live citations returned:
   - `section_title: Pricing` with `chunk_index: 1`
   - `section_title: Overview` with `chunk_index: 0`
6. Human QA on the live UI confirmed chat still streamed an answer and displayed citations after the retrieval-fidelity rebuild

Human QA limitation:

- the current UI exposes citation counts but not the full `section_path` / `heading_level` fields
- those fields were therefore verified at the API/runtime payload layer rather than through a richer citation inspector in the UI

### Evidence summary

Stored retrieval artifacts for the verification corpus showed:

- `chunk | Overview | 0`
- `chunk | Pricing | 1`

Live retrieval response showed:

- `section_title: Pricing`, `chunk_index: 1`
- `section_title: Overview`, `chunk_index: 0`

That confirms the section-aware metadata survived:

- ingestion
- persistence
- indexing
- retrieval
- citation serialization

This pass specifically confirmed that the semantic citation path no longer drops:

- `section_path`
- `heading_level`

### Acceptance criteria

- non-PDF text retrieval is no longer only blind character slicing: met
- section metadata is preserved when the source text has headings: met
- chunk metadata survives through Qdrant search into chat citations, including `section_path` and `heading_level`: met
- cloud markdown workbook artifacts now use the chunked retrieval path: met
- existing runtime shape remains unchanged: met

### Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
python3.12 -m compileall backend/src
python3.12 -m compileall backend/src/ghostdash_api/workflows.py backend/src/ghostdash_api/qdrant_store.py
```

```bash
cd /var/llamaindex/ghoststack-rag
docker compose up -d --build workflow-runtime
```

```bash
cd /var/llamaindex/ghoststack-rag
docker compose up -d --build control-api workflow-runtime agent-ingress
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

```bash
cd /var/llamaindex/ghoststack-rag
docker exec -i ghoststack-rag-control-api-1 python - <<'PY'
from datetime import UTC, datetime
from types import SimpleNamespace

from ghostdash_api.ingest import PDF_ORIGINAL_TEXT_METADATA_KEY, PDF_WINDOW_METADATA_KEY
from ghostdash_api import workflows

document = SimpleNamespace(id='doc-1', filename='large.pdf', corpus='default', source_path='/tmp/large.pdf')
artifact = SimpleNamespace(
    artifact_type='pdf_sentence_window',
    text='full original text',
    metadata_json={
        'document_version_id': 'version-1',
        'content_hash': 'hash-1',
        'page_start': 3,
        'page_end': 4,
        'section_title': 'Overview',
        'section_path': 'Overview > Pricing',
        'heading_level': 2,
        'parse_lane': 'local_pypdf',
        PDF_WINDOW_METADATA_KEY: 'windowed text',
        PDF_ORIGINAL_TEXT_METADATA_KEY: 'full original text',
    },
)
payload = workflows.build_qdrant_payload(document, artifact)
assert payload['section_path'] == 'Overview > Pricing'
assert payload['heading_level'] == 2
assert PDF_WINDOW_METADATA_KEY not in payload['metadata']
assert PDF_ORIGINAL_TEXT_METADATA_KEY not in payload['metadata']

version = SimpleNamespace(id='version-1', version_hash='hash-1', created_at=datetime.now(UTC))
text = (
    '# Overview\n\n'
    'GhostDASH provides grounded retrieval over operator documents. '
    'This section explains the high level architecture and control flow.\n\n'
    '## Pricing\n\n'
    'Pricing guidance should stay grounded in the retrieved source material. '
    'This section exists to verify that structure-aware chunking preserves section metadata.'
)
artifacts = workflows.persist_text_retrieval_artifacts(
    None,
    document=SimpleNamespace(id='doc-1', filename='guide.md', corpus='default', source_path='/tmp/guide.md', source_kind='document'),
    version=version,
    text=text,
    parse_lane='llamaparse',
    chunk_size=90,
    chunk_overlap=10,
    heading_aware=True,
)
assert artifacts[0].metadata_json['section_path'] == 'Overview'
assert any(item.metadata_json['section_path'] == 'Overview > Pricing' for item in artifacts)

class DummySessionContext:
    def __enter__(self):
        return object()
    def __exit__(self, exc_type, exc, tb):
        return False

workflows.SessionLocal = lambda: DummySessionContext()
workflows.get_active_connection = lambda session, provider: object()
workflows.get_default_runtime_profile = lambda session: SimpleNamespace(kb_config_json={'embedding_model_id': 'openai/text-embedding-3-small'})
workflows.find_structured_candidates = lambda message, corpora: []
workflows.embed_texts = lambda *args, **kwargs: [[0.1, 0.2, 0.3]]
workflows.search_vectors = lambda *args, **kwargs: [{
    'text': 'Pricing overview chunk',
    'document_id': 'doc-1',
    'filename': 'guide.md',
    'corpus': 'default',
    'artifact_type': 'chunk',
    'source_path': '/tmp/guide.md',
    'chunk_index': 0,
    'section_title': 'Pricing',
    'section_path': 'Overview > Pricing',
    'heading_level': 2,
    'parse_lane': 'llamaparse',
    'metadata': {
        'section_title': 'Pricing',
        'section_path': 'Overview > Pricing',
        'heading_level': 2,
        'parse_lane': 'llamaparse',
    },
}]
plan = workflows.build_query_plan('Summarize the pricing section', ['default'], 4, 'trace-1')
assert plan['citations'][0]['section_path'] == 'Overview > Pricing'
assert plan['citations'][0]['heading_level'] == 2
print('structure-aware retrieval verification passed')
PY
```

```bash
python3.12 - <<'PY'
from pathlib import Path
Path('/tmp/phase4-structure.md').write_text(
    '# Overview\n\n'
    'GhostDASH provides grounded retrieval over operator documents. '
    'This overview explains the control plane and ingestion path.\n\n'
    '## Pricing\n\n'
    'Pricing guidance should stay grounded in retrieved source material and should not invent values. '
    'Use the Pricing section when users ask policy follow-up questions.\n',
    encoding='utf-8',
)
PY
```

```bash
export CORPUS="phase4-structure-$(date +%s)"
curl -sS -X POST "http://localhost/api/upload" \
  -F "corpus=${CORPUS}" \
  -F "policy_lane=local" \
  -F "file=@/tmp/phase4-structure.md;type=text/markdown"
```

```bash
export CORPUS="replace-with-uploaded-corpus"
python3.12 - <<'PY'
import json, os, time, urllib.request
base = 'http://localhost'
corpus = os.environ['CORPUS']
req = urllib.request.Request(base + '/api/sync', data=json.dumps({'corpus': corpus}).encode(), method='POST')
req.add_header('Content-Type', 'application/json')
task = json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
state = None
for _ in range(90):
    time.sleep(2)
    state = json.loads(urllib.request.urlopen(base + '/api/tasks/' + task['id'], timeout=120).read().decode())
    if state['status'] in {'completed', 'failed'}:
        break
print(json.dumps(state, indent=2))
PY
```

```bash
docker exec ghoststack-rag-postgres-1 psql -U ghostdash -d ghostdash -At -F $'\t' -c \
"select r.artifact_type, r.metadata_json->>'section_title', r.metadata_json->>'chunk_index', left(r.text, 80) from retrieval_artifacts r join documents d on d.id = r.document_id where d.corpus = 'replace-with-uploaded-corpus' order by (r.metadata_json->>'chunk_index')::int;"
```

```bash
python3.12 - <<'PY'
import json, urllib.request
base = 'http://localhost'
payload = {
  'message': 'Summarize the overview and pricing guidance from this markdown file.',
  'corpora': ['replace-with-uploaded-corpus'],
  'api_mode': 'responses',
}
req = urllib.request.Request(base + '/agent/chat', data=json.dumps(payload).encode(), method='POST')
req.add_header('Content-Type', 'application/json')
print(urllib.request.urlopen(req, timeout=120).read().decode())
PY
```

### Human retest request

Please test one headed markdown or text document from the UI and confirm:

- the sync completes successfully
- GhostChat answers use the right section
- the returned citations align with the expected heading context
- if you need to inspect `section_path` / `heading_level`, use the API response because the current UI does not yet render those fields
