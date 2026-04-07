# Native Embedding Cache Artifact

## Intent
This artifact records the native-first embedding cache added to GhostDASH without introducing Redis drift into the current stack.

## Problem
The designer handover asks for Redis-backed LLM caching, but the live compose stack does not include Redis. More importantly, the existing codebase already funnels both ingestion-time and query-time embedding work through a single runtime helper, so adding a cache at that seam is lower-risk and easier to reason about than bolting on new infrastructure first.

## Architectural Decision
Use a Postgres-backed exact-match embedding cache at `backend/src/ghostdash_api/runtime.py::embed_texts()`.

Why this choice:
- Both ingestion indexing and semantic query planning already call `embed_texts()`.
- Postgres is already part of the live stack, so the cache is shared across workers and service restarts.
- The cache stores only text hashes and vectors, not raw source text, which is a better fit for privacy-sensitive material.
- This avoids the false confidence of an in-process cache that would fragment across multiple workers.

## Files Changed
- `backend/src/ghostdash_api/models.py`
- `backend/src/ghostdash_api/runtime.py`
- `backend/src/ghostdash_api/settings.py`
- `backend/tests/test_embedding_cache.py`

## Data Model
New table: `embedding_cache`

Stored fields:
- `provider`
- `base_url`
- `embedding_model`
- `text_hash`
- `text_length`
- `vector_json`
- `hit_count`
- timestamps via `TimestampMixin`

Uniqueness:
- `(provider, base_url, embedding_model, text_hash)`

## Runtime Flow
1. `embed_texts()` normalizes the provider/model/base URL namespace.
2. Each text is hashed with SHA-256.
3. Postgres is checked for exact-match cached vectors in that namespace.
4. Cache hits are returned immediately.
5. Misses are embedded remotely via the existing `OpenAIEmbedding` path.
6. New vectors are persisted into `embedding_cache`.
7. The final return order matches the original request order, including duplicates.

## Telemetry Added
Two instant events now expose cache behavior:
- `embedding_cache.lookup`
- `embedding_cache.store`

Existing outbound embedding calls remain visible through:
- `openai.embeddings`

This means operators can prove cache effectiveness directly from logs.

## TTL Behavior
New setting:
- `app_embedding_cache_ttl_seconds`

Default:
- 30 days

Behavior:
- Expired entries are evicted on lookup.
- Setting the TTL to `0` or a negative value disables expiry.

## Human/Operational Verification Performed
Deployment path:
- Rebuilt and restarted `control-api`, `workflow-runtime`, and `agent-ingress` with `docker compose up -d --build control-api workflow-runtime agent-ingress`.

Functional proof:
- Sent the same semantic `/agent/chat` query twice.
- Observed first request log sequence: `embedding_cache.lookup` with `hits=0`, then `openai.embeddings`, then `embedding_cache.store`.
- Observed second request log sequence: `embedding_cache.lookup` with `hits=1`, `misses=0`, and no outbound `openai.embeddings` call for that repeated query.

Representative evidence from `ghoststack-rag-workflow-runtime-1`:
- First query: lookup miss -> remote embedding call -> store
- Second query: lookup hit -> qdrant search only

## Residual Risk
- The cache is exact-match only for now. It does not perform semantic cache reuse.
- Concurrent identical misses could still race on first-write in very tight timing windows.
- This slice does not yet cache LLM answer generation, only embeddings.
- If the embedding model or base URL changes, the namespace changes as well, which is correct, but old cache rows will remain until TTL expiry.

## Verify Commands
- `cd /var/llamaindex/ghoststack-rag && docker compose up -d --build control-api workflow-runtime agent-ingress`
- `docker logs --tail=200 ghoststack-rag-workflow-runtime-1`
- `curl -sS -X POST http://localhost/agent/chat -H 'Content-Type: application/json' -d '{"message":"cache probe 123","corpora":["default"],"top_k":6,"api_mode":"responses"}'`
- Repeat the same curl command and confirm the second lookup shows `hits: 1` and no matching `openai.embeddings` event.

## Acceptance Criteria
- A repeated semantic query reuses cached embeddings.
- Cache entries are shared through the live Postgres-backed stack rather than process-local memory only.
- Logs expose cache hits and stores clearly enough for operators to confirm behavior.
