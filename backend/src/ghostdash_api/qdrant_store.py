"""Qdrant helpers: collection lifecycle, upsert, search."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    FilterSelector,
    MatchValue,
    PointStruct,
    VectorParams,
)

from .settings import get_settings

settings = get_settings()

# text-embedding-3-small default width
DEFAULT_VECTOR_SIZE = 1536


def client() -> QdrantClient:
    return QdrantClient(
        url=settings.app_qdrant_url,
        api_key=settings.qdrant_api_key or None,
        timeout=120.0,
    )


def ensure_collection(vector_size: int = DEFAULT_VECTOR_SIZE) -> None:
    qc = client()
    name = settings.app_qdrant_collection
    if qc.collection_exists(collection_name=name):
        return
    qc.create_collection(
        collection_name=name,
        vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE),
    )


def delete_document_vectors(document_id: str) -> None:
    qc = client()
    name = settings.app_qdrant_collection
    if not qc.collection_exists(collection_name=name):
        return
    qc.delete(
        collection_name=name,
        points_selector=FilterSelector(
            filter=Filter(
                must=[FieldCondition(key='document_id', match=MatchValue(value=document_id))],
            ),
        ),
    )


def upsert_chunks(
    *,
    document_id: str,
    filename: str,
    corpus: str,
    source_path: str,
    vectors: list[list[float]],
    texts: list[str],
) -> None:
    ensure_collection(vector_size=len(vectors[0]) if vectors else DEFAULT_VECTOR_SIZE)
    qc = client()
    name = settings.app_qdrant_collection
    points: list[PointStruct] = []
    for i, (vec, text) in enumerate(zip(vectors, texts, strict=True)):
        pid = str(uuid4())
        payload: dict[str, Any] = {
            'document_id': document_id,
            'filename': filename,
            'corpus': corpus,
            'chunk_index': i,
            'source_path': source_path,
            'text': text[:8000],
        }
        points.append(PointStruct(id=pid, vector=vec, payload=payload))
    if points:
        qc.upsert(collection_name=name, points=points)


def search_vectors(vector: list[float], corpora: list[str], top_k: int) -> list[dict[str, Any]]:
    qc = client()
    name = settings.app_qdrant_collection
    if not qc.collection_exists(collection_name=name):
        return []
    flt: Filter | None = None
    if corpora:
        flt = Filter(
            should=[FieldCondition(key='corpus', match=MatchValue(value=c)) for c in corpora],
        )
    res = qc.search(
        collection_name=name,
        query_vector=vector,
        limit=top_k,
        query_filter=flt,
        with_payload=True,
    )
    out: list[dict[str, Any]] = []
    for hit in res:
        pl = hit.payload or {}
        out.append(
            {
                'score': hit.score,
                'text': pl.get('text', ''),
                'document_id': pl.get('document_id', ''),
                'filename': pl.get('filename', ''),
                'corpus': pl.get('corpus', ''),
                'chunk_index': pl.get('chunk_index', 0),
                'source_path': pl.get('source_path', ''),
            }
        )
    return out
