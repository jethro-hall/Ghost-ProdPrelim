from __future__ import annotations

from types import SimpleNamespace

import pytest

from ghostdash_api import qdrant_store


class FakeExistingCollectionClient:
    def collection_exists(self, *, collection_name: str) -> bool:
        return True

    def get_collection(self, *, collection_name: str):
        return SimpleNamespace(
            config=SimpleNamespace(
                params=SimpleNamespace(
                    vectors=SimpleNamespace(size=1536),
                )
            )
        )


class FakeSearchClient(FakeExistingCollectionClient):
    def __init__(self) -> None:
        self.query_kwargs: dict[str, object] | None = None

    def query_points(self, **kwargs):
        self.query_kwargs = kwargs
        return SimpleNamespace(points=[])


def test_ensure_collection_rejects_existing_vector_size_mismatch(monkeypatch) -> None:
    monkeypatch.setattr(qdrant_store, "client", lambda: FakeExistingCollectionClient())
    monkeypatch.setattr(qdrant_store.settings, "app_qdrant_collection", "ghostdash_knowledge_e5_v1")

    with pytest.raises(ValueError, match="1536-d vectors"):
        qdrant_store.ensure_collection(vector_size=1024)


def test_upsert_retrieval_artifacts_rejects_vector_size_mismatch(monkeypatch) -> None:
    monkeypatch.setattr(qdrant_store.settings, "app_qdrant_collection", "ghostdash_knowledge_e5_v1")
    monkeypatch.setattr(qdrant_store.settings, "app_qdrant_vector_size", 1024)

    with pytest.raises(ValueError, match="must be 1024-d"):
        qdrant_store.upsert_retrieval_artifacts(
            artifacts=[{"text": "alpha"}],
            vectors=[[0.1] * 1536],
        )


def test_search_vectors_rejects_query_vector_size_mismatch(monkeypatch) -> None:
    monkeypatch.setattr(qdrant_store, "client", lambda: object())
    monkeypatch.setattr(qdrant_store.settings, "app_qdrant_collection", "ghostdash_knowledge_e5_v1")
    monkeypatch.setattr(qdrant_store.settings, "app_qdrant_vector_size", 1024)

    with pytest.raises(ValueError, match="must be 1024-d"):
        qdrant_store.search_vectors([0.1] * 1536, corpora=[], top_k=5)


def test_search_vectors_preserves_corpus_filter_when_constrained_to_document_ids(monkeypatch) -> None:
    fake_client = FakeSearchClient()
    monkeypatch.setattr(qdrant_store, "client", lambda: fake_client)
    monkeypatch.setattr(qdrant_store.settings, "app_qdrant_collection", "ghostdash_knowledge_e5_v1")
    monkeypatch.setattr(qdrant_store.settings, "app_qdrant_vector_size", 1536)
    monkeypatch.setattr(qdrant_store, "Filter", lambda **kwargs: kwargs)
    monkeypatch.setattr(qdrant_store, "FieldCondition", lambda *, key, match: {"key": key, "match": match})
    monkeypatch.setattr(qdrant_store, "MatchValue", lambda *, value: {"value": value})
    monkeypatch.setattr(qdrant_store, "MatchAny", lambda *, any: {"any": any})

    qdrant_store.search_vectors(
        [0.1] * 1536,
        corpora=["default", "finance"],
        top_k=5,
        document_ids=["doc-1", "doc-2"],
    )

    assert fake_client.query_kwargs is not None
    assert fake_client.query_kwargs["limit"] == 5
    assert fake_client.query_kwargs["query_filter"] == {
        "must": [
            {"key": "corpus", "match": {"any": ["default", "finance"]}},
            {"key": "document_id", "match": {"any": ["doc-1", "doc-2"]}},
        ]
    }
