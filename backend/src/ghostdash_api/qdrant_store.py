"""Qdrant helpers for retrieval artifacts."""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

try:
    from qdrant_client import QdrantClient
    from qdrant_client.models import (
        Distance,
        FieldCondition,
        Filter,
        FilterSelector,
        MatchAny,
        MatchValue,
        PayloadSchemaType,
        PointStruct,
        VectorParams,
    )
except ModuleNotFoundError:  # pragma: no cover - exercised only in stripped test hosts
    QdrantClient = None  # type: ignore[assignment]
    Distance = FieldCondition = Filter = FilterSelector = MatchAny = MatchValue = PayloadSchemaType = PointStruct = VectorParams = None

from .settings import get_settings
from .telemetry import wrap_outbound_call

settings = get_settings()

DEFAULT_VECTOR_SIZE = 1024
DEFAULT_UPSERT_MAX_PAYLOAD_BYTES = 24 * 1024 * 1024
DEFAULT_UPSERT_MAX_POINTS = 128


def client() -> QdrantClient:
    if QdrantClient is None:
        raise RuntimeError("qdrant_client is not installed")
    return QdrantClient(
        url=settings.app_qdrant_url,
        api_key=settings.qdrant_api_key or None,
        timeout=120.0,
    )


def configured_vector_size() -> int:
    return max(1, int(getattr(settings, "app_qdrant_vector_size", DEFAULT_VECTOR_SIZE)))


def _extract_collection_vector_size(collection_info: Any) -> int:
    vectors = getattr(getattr(getattr(collection_info, "config", None), "params", None), "vectors", None)
    if vectors is None:
        raise RuntimeError("Unable to resolve Qdrant collection vector size from collection metadata")
    if hasattr(vectors, "size"):
        return int(vectors.size)
    if isinstance(vectors, dict):
        if len(vectors) != 1:
            raise RuntimeError("Named-vector Qdrant collections are not supported by this runtime")
        only_vector = next(iter(vectors.values()))
        if hasattr(only_vector, "size"):
            return int(only_vector.size)
    raise RuntimeError("Unsupported Qdrant vector configuration returned by collection metadata")


def _assert_collection_vector_size(qc: QdrantClient, collection_name: str, expected_size: int) -> None:
    actual_size = _extract_collection_vector_size(qc.get_collection(collection_name=collection_name))
    if actual_size != expected_size:
        raise ValueError(
            f"Qdrant collection '{collection_name}' is configured for {actual_size}-d vectors, "
            f"but GhostDASH is configured for {expected_size}-d vectors. "
            "Use a clean collection name or align APP_QDRANT_VECTOR_SIZE with the embedding model."
        )


def _assert_vector_batch_size(vectors: list[list[float]], expected_size: int, *, collection_name: str) -> None:
    invalid_sizes = sorted({len(vector) for vector in vectors if len(vector) != expected_size})
    if not invalid_sizes:
        return
    if len(invalid_sizes) == 1:
        received = str(invalid_sizes[0])
    else:
        received = ", ".join(str(size) for size in invalid_sizes)
    raise ValueError(
        f"Embedding vectors for Qdrant collection '{collection_name}' must be {expected_size}-d, "
        f"but received vector sizes: {received}."
    )


def _normalize_keyword_values(values: list[str] | None) -> list[str]:
    normalized: list[str] = []
    for value in values or []:
        text = str(value).strip()
        if text:
            normalized.append(text)
    return normalized


def _build_keyword_match(values: list[str] | None):
    normalized = _normalize_keyword_values(values)
    if not normalized:
        return None
    if len(normalized) == 1:
        return MatchValue(value=normalized[0])
    return MatchAny(any=normalized)


def _build_search_filter(*, corpora: list[str] | None, document_ids: list[str] | None = None) -> Filter | None:
    must = []
    corpus_match = _build_keyword_match(corpora)
    if corpus_match is not None:
        must.append(FieldCondition(key="corpus", match=corpus_match))
    document_match = _build_keyword_match(document_ids)
    if document_match is not None:
        must.append(FieldCondition(key="document_id", match=document_match))
    if not must:
        return None
    return Filter(must=must)


def ensure_collection(
    vector_size: int | None = None,
    trace_id: str | None = None,
    service: str = "ghostdash-api",
) -> None:
    qc = client()
    name = settings.app_qdrant_collection
    expected_size = configured_vector_size() if vector_size is None else int(vector_size)

    def _ensure() -> None:
        if qc.collection_exists(collection_name=name):
            _assert_collection_vector_size(qc, name, expected_size)
        else:
            qc.create_collection(
                collection_name=name,
                vectors_config=VectorParams(size=expected_size, distance=Distance.COSINE),
            )
        for field_name in ("corpus", "document_id", "artifact_type", "content_hash"):
            qc.create_payload_index(
                collection_name=name,
                field_name=field_name,
                field_schema=PayloadSchemaType.KEYWORD,
            )

    if trace_id:
        wrap_outbound_call(
            trace_id=trace_id,
            service=service,
            route="qdrant.ensure_collection",
            fn=_ensure,
        )
    else:
        _ensure()


def delete_document_vectors(document_id: str, trace_id: str | None = None, service: str = "workflow-runtime") -> None:
    qc = client()
    name = settings.app_qdrant_collection

    def _delete() -> None:
        if not qc.collection_exists(collection_name=name):
            return
        qc.delete(
            collection_name=name,
            points_selector=FilterSelector(
                filter=Filter(
                    must=[FieldCondition(key="document_id", match=MatchValue(value=document_id))],
                ),
            ),
        )

    if trace_id:
        wrap_outbound_call(trace_id=trace_id, service=service, route="qdrant.delete", fn=_delete)
    else:
        _delete()


def delete_corpus_vectors(corpus: str, trace_id: str | None = None, service: str = "control-api") -> None:
    qc = client()
    name = settings.app_qdrant_collection

    def _delete() -> None:
        if not qc.collection_exists(collection_name=name):
            return
        qc.delete(
            collection_name=name,
            points_selector=FilterSelector(
                filter=Filter(
                    must=[FieldCondition(key="corpus", match=MatchValue(value=corpus))],
                ),
            ),
        )

    if trace_id:
        wrap_outbound_call(trace_id=trace_id, service=service, route="qdrant.delete", fn=_delete)
    else:
        _delete()


def count_corpus_vectors(corpus: str, trace_id: str | None = None, service: str = "control-api") -> int:
    qc = client()
    name = settings.app_qdrant_collection

    def _count() -> int:
        if not qc.collection_exists(collection_name=name):
            return 0
        response = qc.count(
            collection_name=name,
            count_filter=Filter(
                must=[FieldCondition(key="corpus", match=MatchValue(value=corpus))],
            ),
            exact=True,
        )
        return int(getattr(response, "count", 0) or 0)

    if trace_id:
        return wrap_outbound_call(trace_id=trace_id, service=service, route="qdrant.count", fn=_count)
    return _count()


def _estimate_point_bytes(vector: list[float], payload: dict[str, Any]) -> int:
    payload_size = len(json.dumps(payload, default=str).encode("utf-8"))
    # Vector payload overhead is roughly float bytes + JSON structural overhead.
    vector_size = (len(vector) * 8) + (len(vector) * 2) + 128
    return payload_size + vector_size


def upsert_retrieval_artifacts(
    *,
    artifacts: list[dict[str, Any]],
    vectors: list[list[float]],
    trace_id: str | None = None,
    service: str = "workflow-runtime",
) -> list[str]:
    expected_size = configured_vector_size()
    _assert_vector_batch_size(vectors, expected_size, collection_name=settings.app_qdrant_collection)
    ensure_collection(
        vector_size=expected_size,
        trace_id=trace_id,
        service=service,
    )
    qc = client()
    name = settings.app_qdrant_collection

    ids: list[str] = []

    def _upsert() -> list[str]:
        points_with_size: list[tuple[PointStruct, int]] = []
        for vector, artifact in zip(vectors, artifacts, strict=True):
            point_id = str(uuid4())
            ids.append(point_id)
            payload: dict[str, Any] = dict(artifact)
            payload["text"] = str(payload.get("text", ""))[:8000]
            estimated_bytes = _estimate_point_bytes(vector, payload)
            points_with_size.append((PointStruct(id=point_id, vector=vector, payload=payload), estimated_bytes))

        if not points_with_size:
            return ids

        max_payload_bytes = max(
            1024 * 1024,
            int(getattr(settings, "app_qdrant_upsert_max_payload_bytes", DEFAULT_UPSERT_MAX_PAYLOAD_BYTES)),
        )
        max_points = max(1, int(getattr(settings, "app_qdrant_upsert_max_points", DEFAULT_UPSERT_MAX_POINTS)))

        batch: list[PointStruct] = []
        batch_bytes = 0

        def flush() -> None:
            nonlocal batch, batch_bytes
            if not batch:
                return
            qc.upsert(collection_name=name, points=batch)
            batch = []
            batch_bytes = 0

        for point, estimated_bytes in points_with_size:
            exceeds_batch_limit = batch and (
                len(batch) >= max_points or (batch_bytes + estimated_bytes) > max_payload_bytes
            )
            if exceeds_batch_limit:
                flush()

            batch.append(point)
            batch_bytes += estimated_bytes

            if len(batch) >= max_points or batch_bytes >= max_payload_bytes:
                flush()

        flush()
        return ids

    if trace_id:
        return wrap_outbound_call(trace_id=trace_id, service=service, route="qdrant.upsert", fn=_upsert)
    return _upsert()


def upsert_chunks(
    *,
    document_id: str,
    filename: str,
    corpus: str,
    source_path: str,
    vectors: list[list[float]],
    texts: list[str],
    trace_id: str | None = None,
    service: str = "workflow-runtime",
) -> None:
    artifacts = [
        {
            "document_id": document_id,
            "filename": filename,
            "corpus": corpus,
            "artifact_type": "chunk",
            "chunk_index": idx,
            "source_path": source_path,
            "text": text,
            "metadata": {},
        }
        for idx, text in enumerate(texts)
    ]
    upsert_retrieval_artifacts(artifacts=artifacts, vectors=vectors, trace_id=trace_id, service=service)


def search_vectors(
    vector: list[float],
    corpora: list[str],
    top_k: int,
    document_ids: list[str] | None = None,
    trace_id: str | None = None,
    service: str = "agent-ingress",
) -> list[dict[str, Any]]:
    qc = client()
    name = settings.app_qdrant_collection
    expected_size = configured_vector_size()

    def _search() -> list[dict[str, Any]]:
        if len(vector) != expected_size:
            raise ValueError(
                f"Search vectors for Qdrant collection '{name}' must be {expected_size}-d, "
                f"but received {len(vector)} dimensions."
            )
        if not qc.collection_exists(collection_name=name):
            return []
        _assert_collection_vector_size(qc, name, expected_size)
        qdrant_filter = _build_search_filter(corpora=corpora, document_ids=document_ids)
        response = qc.query_points(
            collection_name=name,
            query=vector,
            limit=top_k,
            query_filter=qdrant_filter,
            with_payload=True,
        )
        out: list[dict[str, Any]] = []
        for hit in response.points:
            payload = hit.payload or {}
            metadata = payload.get("metadata", {}) or {}
            out.append(
                {
                    "score": hit.score,
                    "text": payload.get("text", ""),
                    "document_id": payload.get("document_id", ""),
                    "filename": payload.get("filename", ""),
                    "corpus": payload.get("corpus", ""),
                    "artifact_type": payload.get("artifact_type", "chunk"),
                    "chunk_index": payload.get("chunk_index", metadata.get("chunk_index", 0)),
                    "source_path": payload.get("source_path", ""),
                    "page_start": payload.get("page_start"),
                    "page_end": payload.get("page_end"),
                    "section_title": payload.get("section_title"),
                    "section_path": payload.get("section_path", metadata.get("section_path")),
                    "heading_level": payload.get("heading_level", metadata.get("heading_level")),
                    "parse_lane": payload.get("parse_lane"),
                    "metadata": metadata,
                }
            )
        return out

    if trace_id:
        return wrap_outbound_call(
            trace_id=trace_id,
            service=service,
            route="qdrant.search",
            fn=_search,
        )
    return _search()
