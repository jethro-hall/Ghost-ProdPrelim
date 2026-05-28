# Phase 1B Local GPU Embedding Cutover

## Objective

Cut GhostDASH over from the legacy OpenAI small embedding default to a local GPU-served embedding path on the host NVIDIA Tesla T4, while keeping the LlamaIndex-native `OpenAIEmbedding(api_base=...)` seam intact and avoiding legacy 1536-d Qdrant conflicts.

## Final Design

- LLM traffic remains on the existing OpenAI-compatible chat path.
- Embedding traffic is separated onto a dedicated TEI sidecar via `OPENAI_EMBEDDING_BASE_URL` and `OPENAI_EMBEDDING_API_KEY`.
- The default embedding model is now `openai/intfloat/multilingual-e5-large-instruct`.
- The physical Qdrant backing collection is now `ghostdash_knowledge_e5_v1`.
- The physical Qdrant vector size is now explicitly configured to `1024`.
- Default runtime-profile and collection metadata are normalized away from `text-embedding-3-small` when they still carry the legacy default.

## TEI Sidecar

Service: `tei-embeddings`

- Image: `ghcr.io/huggingface/text-embeddings-inference:turing-1.9`
- Model: `intfloat/multilingual-e5-large-instruct`
- Served model name: `intfloat/multilingual-e5-large-instruct`
- Internal port: `80`
- Base URL used by GhostDASH: `http://tei-embeddings:80/v1`
- Dtype: `float16`
- Tokenization workers: `4`
- Max concurrent requests: `16`
- Max batch tokens: `8192`
- Max batch requests: `8`
- Max client batch size: `8`
- Auto truncate: `true`
- Weight cache volume: `tei_cache:/data`

Note: live validation showed this TEI image binds to port `80`, not `3000`. The cutover uses `:80/v1` accordingly.

## Backend Behavior

- `runtime.py` now resolves embedding base URL and embedding API key independently from LLM settings.
- When a dedicated embedding base URL is configured and no dedicated embedding key is supplied, GhostDASH uses a local placeholder bearer token (`local-tei`) so the OpenAI client path still works without leaking the LLM provider key to TEI.
- Embedding cache namespacing now includes the embedding endpoint base URL, so cache rows do not collide across different embedding backends.
- Qdrant collection sizing no longer relies on first-batch inference.
- Upserts and searches now fail clearly when vectors do not match the configured `APP_QDRANT_VECTOR_SIZE`.

## Collection Strategy

- Legacy `ghostdash_knowledge` is not reused for the first local generation.
- The first-generation local target is `ghostdash_knowledge_e5_v1`.
- This avoids a silent 1536-d versus 1024-d conflict with previous `text-embedding-3-small` vectors.
- The clean collection can be created lazily on first write, but was also verified live via `ensure_collection()`.

## Environment Defaults

Documented in `.env.example`:

- `APP_DEFAULT_EMBEDDING_MODEL=openai/intfloat/multilingual-e5-large-instruct`
- `OPENAI_EMBEDDING_BASE_URL=http://tei-embeddings:80/v1`
- `OPENAI_EMBEDDING_API_KEY=local-tei`
- `APP_QDRANT_COLLECTION=ghostdash_knowledge_e5_v1`
- `APP_QDRANT_VECTOR_SIZE=1024`

Important: compose now reads `APP_DEFAULT_EMBEDDING_MODEL` directly so stale `OPENAI_EMBEDDING_MODEL=text-embedding-3-small` values do not keep the stack pinned to the legacy model.

## Live Verification

### Commands run

```bash
docker compose config
docker compose up -d --build tei-embeddings workflow-runtime control-api agent-ingress ui
curl -s http://127.0.0.1/api/runtime/defaults
curl -s http://127.0.0.1/api/collections
docker exec ghoststack-rag-workflow-runtime-1 python -c "import httpx; print(httpx.get('http://tei-embeddings:80/health').status_code)"
docker exec ghoststack-rag-workflow-runtime-1 python -c "import httpx, json; print(json.dumps(httpx.get('http://tei-embeddings:80/info').json(), separators=(',', ':')))"
docker exec ghoststack-rag-workflow-runtime-1 python -c "import httpx; response=httpx.post('http://tei-embeddings:80/v1/embeddings', headers={'Authorization':'Bearer local-tei'}, json={'model':'intfloat/multilingual-e5-large-instruct','input':['hello world']}); payload=response.json(); print(response.status_code, len(payload['data'][0]['embedding']))"
docker exec ghoststack-rag-workflow-runtime-1 python -c "from ghostdash_api.qdrant_store import ensure_collection; ensure_collection(); import httpx; print(httpx.get('http://qdrant:6333/collections/ghostdash_knowledge_e5_v1').json()['result']['config']['params']['vectors']['size'])"
```

### Observed results

- Runtime defaults now report `embedding_model_id = openai/intfloat/multilingual-e5-large-instruct`
- Live collection metadata now reports `embedding_model_id = openai/intfloat/multilingual-e5-large-instruct`
- TEI health returned `200`
- TEI OpenAI-style embedding request returned `200` with vector length `1024`
- Qdrant backing collection was created and verified at `1024` dimensions
- Browser verification confirmed the app pages display the new embedding model and no longer hardcode the old physical collection name on the Vectors page

## Acceptance Criteria

- Default runtime profile no longer reports `text-embedding-3-small`
- Collection metadata no longer reports `text-embedding-3-small` for the default/live logical collections
- TEI sidecar is reachable from backend services over the OpenAI-style embedding path
- TEI returns `1024`-dimensional embeddings for the served model
- Qdrant uses a clean first-generation physical collection with explicit `1024`-dimensional vectors
- Backend rejects vector-size mismatches clearly instead of silently inferring or drifting
- UI surfaces the new embedding model in human-facing runtime views

## Risks And Follow-Up

- `multilingual-e5-large-instruct` is now operational through the OpenAI-compatible seam, but a later retrieval-quality pass may still want dedicated query/document prompt shaping for best E5 behavior.
- This host has one T4 shared across TEI and Qdrant GPU indexing. If GPU memory pressure appears under heavier load, the first operational lever is disabling Qdrant GPU indexing via `QDRANT_GPU_INDEXING=0`.
