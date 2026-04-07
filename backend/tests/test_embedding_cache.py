from __future__ import annotations

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from ghostdash_api.database import Base
from ghostdash_api.models import ConnectionRecord, EmbeddingCacheRecord
from ghostdash_api import runtime


class FakeEmbedModel:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def get_text_embedding_batch(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [[float(len(text))] for text in texts]


def configure_runtime(monkeypatch):
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(runtime, "SessionLocal", SessionLocal)
    monkeypatch.setattr(runtime.settings, "app_embedding_cache_enabled", True)
    monkeypatch.setattr(runtime.settings, "app_embedding_cache_ttl_seconds", 60 * 60)
    return SessionLocal


def make_connection(*, model: str = "openai/text-embedding-3-small", base_url: str = "https://api.openai.com/v1") -> ConnectionRecord:
    return ConnectionRecord(
        provider="openai",
        label="OpenAI",
        api_key="test-key",
        base_url=base_url,
        chat_model="openai/gpt-5.4",
        embedding_model=model,
        enabled=True,
    )


def test_embed_texts_reuses_cached_vectors(monkeypatch):
    SessionLocal = configure_runtime(monkeypatch)
    fake_model = FakeEmbedModel()
    monkeypatch.setattr(runtime, "_get_embed_model", lambda connection: fake_model)
    connection = make_connection()

    first = runtime.embed_texts(["alpha", "beta", "alpha"], connection)
    second = runtime.embed_texts(["alpha", "beta"], connection)

    assert first == [[5.0], [4.0], [5.0]]
    assert second == [[5.0], [4.0]]
    assert fake_model.calls == [["alpha", "beta"]]

    with SessionLocal() as session:
        rows = list(session.scalars(select(EmbeddingCacheRecord).order_by(EmbeddingCacheRecord.text_hash.asc())))

    assert len(rows) == 2
    assert sorted(row.hit_count for row in rows) == [1, 1]


def test_embed_cache_separates_models(monkeypatch):
    SessionLocal = configure_runtime(monkeypatch)
    fake_model = FakeEmbedModel()
    monkeypatch.setattr(runtime, "_get_embed_model", lambda connection: fake_model)

    runtime.embed_texts(["alpha"], make_connection(model="openai/text-embedding-3-small"))
    runtime.embed_texts(["alpha"], make_connection(model="openai/text-embedding-3-large"))

    assert fake_model.calls == [["alpha"], ["alpha"]]

    with SessionLocal() as session:
        rows = list(session.scalars(select(EmbeddingCacheRecord).order_by(EmbeddingCacheRecord.embedding_model.asc())))

    assert [row.embedding_model for row in rows] == ["text-embedding-3-large", "text-embedding-3-small"]
