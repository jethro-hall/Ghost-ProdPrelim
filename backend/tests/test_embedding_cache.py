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


def make_connection(*, base_url: str = "https://api.openai.com/v1") -> ConnectionRecord:
    return ConnectionRecord(
        provider="openai",
        label="OpenAI",
        api_key="test-key",
        base_url=base_url,
        enabled=True,
    )


def test_embed_texts_reuses_cached_vectors(monkeypatch):
    SessionLocal = configure_runtime(monkeypatch)
    fake_model = FakeEmbedModel()
    monkeypatch.setattr(runtime, "_get_embed_model", lambda connection, **_: fake_model)
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


def test_embed_texts_chunks_requests_to_configured_batch_size(monkeypatch):
    configure_runtime(monkeypatch)
    fake_model = FakeEmbedModel()
    monkeypatch.setattr(runtime, "_get_embed_model", lambda connection, **_: fake_model)
    monkeypatch.setattr(runtime.settings, "app_embedding_batch_size", 2)

    vectors = runtime.embed_texts(["alpha", "beta", "gamma", "delta", "epsilon"], make_connection())

    assert vectors == [[5.0], [4.0], [5.0], [5.0], [7.0]]
    assert fake_model.calls == [["alpha", "beta"], ["gamma", "delta"], ["epsilon"]]


def test_embed_cache_separates_models(monkeypatch):
    SessionLocal = configure_runtime(monkeypatch)
    fake_model = FakeEmbedModel()
    monkeypatch.setattr(runtime, "_get_embed_model", lambda connection, **_: fake_model)

    runtime.embed_texts(["alpha"], make_connection(), embedding_model="openai/text-embedding-3-small")
    runtime.embed_texts(["alpha"], make_connection(), embedding_model="openai/text-embedding-3-large")

    assert fake_model.calls == [["alpha"], ["alpha"]]

    with SessionLocal() as session:
        rows = list(session.scalars(select(EmbeddingCacheRecord).order_by(EmbeddingCacheRecord.embedding_model.asc())))

    assert [row.embedding_model for row in rows] == ["text-embedding-3-large", "text-embedding-3-small"]


def test_embed_cache_namespace_separates_embedding_base_urls(monkeypatch):
    SessionLocal = configure_runtime(monkeypatch)
    fake_model = FakeEmbedModel()
    monkeypatch.setattr(runtime, "_get_embed_model", lambda connection, **_: fake_model)

    monkeypatch.setattr(runtime.settings, "openai_embedding_base_url", "http://tei-a:3000/v1")
    runtime.embed_texts(["alpha"], make_connection())

    monkeypatch.setattr(runtime.settings, "openai_embedding_base_url", "http://tei-b:3000/v1")
    runtime.embed_texts(["alpha"], make_connection())

    assert fake_model.calls == [["alpha"], ["alpha"]]

    with SessionLocal() as session:
        rows = list(session.scalars(select(EmbeddingCacheRecord).order_by(EmbeddingCacheRecord.base_url.asc())))

    assert [row.base_url for row in rows] == ["http://tei-a:3000/v1", "http://tei-b:3000/v1"]


def test_get_embed_model_uses_model_name_for_custom_models_on_local_embedding_endpoint(monkeypatch):
    captured: dict[str, object] = {}

    class FakeOpenAIEmbedding:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(runtime, "OpenAIEmbedding", FakeOpenAIEmbedding)
    monkeypatch.setattr(runtime.settings, "app_embedding_batch_size", 8)
    monkeypatch.setattr(runtime.settings, "openai_embedding_base_url", "http://tei-embeddings:80/v1")
    monkeypatch.setattr(runtime.settings, "openai_embedding_api_key", None)

    connection = runtime.ProviderConnectionConfig(
        provider="openai",
        label="OpenAI",
        api_key="real-openai-key",
        base_url="https://api.openai.com/v1",
    )

    runtime._get_embed_model(connection, embedding_model="openai/intfloat/multilingual-e5-large-instruct")

    assert captured["model"] == runtime.OPENAI_EMBEDDING_VALIDATION_MODEL
    assert captured["model_name"] == "intfloat/multilingual-e5-large-instruct"
    assert captured["api_base"] == "http://tei-embeddings:80/v1"
    assert captured["api_key"] == "local-tei"
    assert captured["embed_batch_size"] == 8


def test_get_embed_model_keeps_standard_openai_behavior(monkeypatch):
    captured: dict[str, object] = {}

    class FakeOpenAIEmbedding:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(runtime, "OpenAIEmbedding", FakeOpenAIEmbedding)
    monkeypatch.setattr(runtime.settings, "app_embedding_batch_size", 8)
    monkeypatch.setattr(runtime.settings, "openai_embedding_base_url", "https://api.openai.com/v1")
    monkeypatch.setattr(runtime.settings, "openai_embedding_api_key", None)

    connection = runtime.ProviderConnectionConfig(
        provider="openai",
        label="OpenAI",
        api_key="real-openai-key",
        base_url="https://api.openai.com/v1",
    )

    runtime._get_embed_model(connection, embedding_model="openai/text-embedding-3-small")

    assert captured["model"] == "text-embedding-3-small"
    assert "model_name" not in captured
    assert captured["api_base"] == "https://api.openai.com/v1"
    assert captured["api_key"] == "real-openai-key"
    assert captured["embed_batch_size"] == 8


def test_provider_base_url_normalizes_openai_compatible_endpoint_suffixes():
    connection = runtime.ProviderConnectionConfig(
        provider="openai",
        label="RideAI",
        api_key="internal-key",
        base_url="https://one.rideai.com.au/api/llamaindex/v1/chat/completions",
    )

    assert runtime._provider_base_url(connection) == "https://one.rideai.com.au/api/llamaindex/v1"


def test_build_llm_adds_internal_header_for_rideai_gateway(monkeypatch):
    captured: dict[str, object] = {}

    class FakeOpenAI:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(runtime, "LlamaIndexOpenAI", FakeOpenAI)
    connection = runtime.ProviderConnectionConfig(
        provider="openai",
        label="RideAI",
        api_key="change_me_llamaindex_internal_key",
        base_url="https://one.rideai.com.au/api/llamaindex/v1/chat/completions",
    )

    runtime._build_llm(
        connection,
        model_id="llama31-8b",
        temperature=0,
        max_tokens=None,
        system_prompt="test",
    )

    assert captured["api_base"] == "https://one.rideai.com.au/api/llamaindex/v1"
    assert captured["default_headers"] == {"X-Internal-Key": "change_me_llamaindex_internal_key"}
    assert captured["api_key"] == "change_me_llamaindex_internal_key"


def test_get_embed_model_adds_internal_header_for_rideai_embedding_gateway(monkeypatch):
    captured: dict[str, object] = {}

    class FakeOpenAIEmbedding:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

    monkeypatch.setattr(runtime, "OpenAIEmbedding", FakeOpenAIEmbedding)
    monkeypatch.setattr(runtime.settings, "app_embedding_batch_size", 8)
    monkeypatch.setattr(
        runtime.settings,
        "openai_embedding_base_url",
        "https://one.rideai.com.au/api/llamaindex/v1",
    )
    monkeypatch.setattr(runtime.settings, "openai_embedding_api_key", "local-tei")

    connection = runtime.ProviderConnectionConfig(
        provider="openai",
        label="RideAI",
        api_key="change_me_llamaindex_internal_key",
        base_url="https://one.rideai.com.au/api/llamaindex/v1/chat/completions",
    )

    runtime._get_embed_model(connection, embedding_model="openai/intfloat/multilingual-e5-large-instruct")

    assert captured["api_base"] == "https://one.rideai.com.au/api/llamaindex/v1"
    assert captured["default_headers"] == {"X-Internal-Key": "change_me_llamaindex_internal_key"}
    assert captured["api_key"] == "change_me_llamaindex_internal_key"
    assert captured["model"] == runtime.OPENAI_EMBEDDING_VALIDATION_MODEL
    assert captured["model_name"] == "intfloat/multilingual-e5-large-instruct"
