from __future__ import annotations

import hashlib
import time
from datetime import UTC, datetime, timedelta
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.llms.openai import OpenAI as LlamaIndexOpenAI
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import ConnectionRecord, EmbeddingCacheRecord
from .settings import get_settings
from .telemetry import log_event, log_instant_event, new_span_id, wrap_outbound_call

settings = get_settings()
SYSTEM_PROMPT = (
    "You answer using retrieved knowledge only. "
    "Always ground the answer in the provided context and say when the context is insufficient."
)


@dataclass(slots=True)
class ProviderConnectionConfig:
    provider: str
    label: str
    api_key: str | None
    base_url: str | None
    chat_model: str | None
    embedding_model: str | None


def _normalize_provider_model_id(provider: str, model_id: str | None, fallback: str) -> str:
    model = model_id or fallback
    if provider == "openai" and model.startswith("openai/"):
        return model.split("/", 1)[1]
    return model


def _merge_provider_connection(
    connection: ConnectionRecord,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    chat_model: str | None = None,
    embedding_model: str | None = None,
) -> ProviderConnectionConfig:
    return ProviderConnectionConfig(
        provider=connection.provider,
        label=connection.label,
        api_key=api_key if api_key not in (None, "") else connection.api_key,
        base_url=base_url if base_url not in (None, "") else connection.base_url,
        chat_model=chat_model if chat_model not in (None, "") else connection.chat_model,
        embedding_model=embedding_model if embedding_model not in (None, "") else connection.embedding_model,
    )


def _provider_api_key(connection: ProviderConnectionConfig) -> str:
    api_key = connection.api_key or settings.openai_api_key
    if not api_key:
        raise ValueError("No API key configured for the selected provider connection")
    return api_key


def _provider_base_url(connection: ProviderConnectionConfig) -> str:
    return (connection.base_url or settings.openai_base_url).rstrip("/")


def _get_llm(connection: ProviderConnectionConfig) -> LlamaIndexOpenAI:
    return _build_llm(
        connection,
        model_id=connection.chat_model,
        temperature=0,
        max_tokens=None,
        system_prompt=SYSTEM_PROMPT,
    )


def _build_llm(
    connection: ProviderConnectionConfig,
    *,
    model_id: str | None,
    temperature: float,
    max_tokens: int | None,
    system_prompt: str,
) -> LlamaIndexOpenAI:
    model = _normalize_provider_model_id(connection.provider, model_id, settings.app_default_chat_model)
    return LlamaIndexOpenAI(
        model=model,
        api_key=_provider_api_key(connection),
        api_base=_provider_base_url(connection),
        temperature=temperature,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
    )


def _get_embed_model(connection: ProviderConnectionConfig) -> OpenAIEmbedding:
    model = _normalize_provider_model_id(
        connection.provider,
        connection.embedding_model,
        settings.app_default_embedding_model,
    )
    return OpenAIEmbedding(
        model=model,
        api_key=_provider_api_key(connection),
        api_base=_provider_base_url(connection),
    )


def _embedding_cache_key(connection: ProviderConnectionConfig, text: str) -> tuple[str, str, str, str]:
    model = _normalize_provider_model_id(
        connection.provider,
        connection.embedding_model,
        settings.app_default_embedding_model,
    )
    text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return connection.provider, _provider_base_url(connection), model, text_hash


def _embedding_cache_cutoff() -> datetime | None:
    ttl_seconds = settings.app_embedding_cache_ttl_seconds
    if ttl_seconds <= 0:
        return None
    return datetime.now(UTC) - timedelta(seconds=ttl_seconds)


def _load_cached_embeddings(
    connection: ProviderConnectionConfig,
    text_batch: list[str],
) -> tuple[dict[str, list[float]], tuple[str, str, str], int]:
    provider, base_url, model, _ = _embedding_cache_key(connection, text_batch[0])
    hashes = {hashlib.sha256(text.encode("utf-8")).hexdigest() for text in text_batch}
    cutoff = _embedding_cache_cutoff()
    cached: dict[str, list[float]] = {}
    stale_count = 0
    with SessionLocal() as session:
        rows = list(
            session.scalars(
                select(EmbeddingCacheRecord).where(
                    EmbeddingCacheRecord.provider == provider,
                    EmbeddingCacheRecord.base_url == base_url,
                    EmbeddingCacheRecord.embedding_model == model,
                    EmbeddingCacheRecord.text_hash.in_(hashes),
                )
            )
        )
        dirty = False
        for row in rows:
            if cutoff is not None and row.updated_at < cutoff:
                session.delete(row)
                stale_count += 1
                dirty = True
                continue
            row.hit_count += 1
            cached[row.text_hash] = list(row.vector_json)
            dirty = True
        if dirty:
            session.commit()
    return cached, (provider, base_url, model), stale_count


def _store_cached_embeddings(
    namespace: tuple[str, str, str],
    text_to_vector: list[tuple[str, list[float]]],
) -> None:
    provider, base_url, model = namespace
    if not text_to_vector:
        return
    with SessionLocal() as session:
        hashes = [hashlib.sha256(text.encode("utf-8")).hexdigest() for text, _ in text_to_vector]
        existing = {
            row.text_hash: row
            for row in session.scalars(
                select(EmbeddingCacheRecord).where(
                    EmbeddingCacheRecord.provider == provider,
                    EmbeddingCacheRecord.base_url == base_url,
                    EmbeddingCacheRecord.embedding_model == model,
                    EmbeddingCacheRecord.text_hash.in_(hashes),
                )
            )
        }
        for text, vector in text_to_vector:
            text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
            row = existing.get(text_hash)
            if row is None:
                session.add(
                    EmbeddingCacheRecord(
                        provider=provider,
                        base_url=base_url,
                        embedding_model=model,
                        text_hash=text_hash,
                        text_length=len(text),
                        vector_json=vector,
                    )
                )
                continue
            row.vector_json = vector
            row.text_length = len(text)
        session.commit()


def seed_default_connections(session: Session) -> None:
    defaults = {
        "openai": {
            "label": "OpenAI",
            "api_key": settings.openai_api_key,
            "base_url": settings.openai_base_url,
            "chat_model": settings.app_default_chat_model,
            "embedding_model": settings.app_default_embedding_model,
            "enabled": bool(settings.openai_api_key),
        }
    }
    for provider, payload in defaults.items():
        existing = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == provider))
        if existing:
            if settings.openai_api_key and not existing.api_key:
                existing.api_key = settings.openai_api_key
                existing.enabled = True
            existing.chat_model = existing.chat_model or settings.app_default_chat_model
            existing.embedding_model = existing.embedding_model or settings.app_default_embedding_model
            existing.base_url = existing.base_url or settings.openai_base_url
            continue
        session.add(ConnectionRecord(provider=provider, **payload))
    session.commit()


def list_connections(session: Session) -> list[ConnectionRecord]:
    return list(session.scalars(select(ConnectionRecord).order_by(ConnectionRecord.provider)))


def save_connection(session: Session, provider: str, **fields) -> ConnectionRecord:
    record = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == provider))
    if record is None:
        record = ConnectionRecord(provider=provider, label=fields.get("label") or provider.title())
        session.add(record)

    for key, value in fields.items():
        if key == "api_key" and value in (None, ""):
            continue
        setattr(record, key, value)

    if provider == "openai":
        record.chat_model = record.chat_model or settings.app_default_chat_model
        record.embedding_model = record.embedding_model or settings.app_default_embedding_model
        record.base_url = record.base_url or settings.openai_base_url

    session.commit()
    session.refresh(record)
    return record


def get_active_connection(session: Session, provider: str = "openai") -> ConnectionRecord:
    connection = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == provider))
    if connection is None:
        raise ValueError(f"No connection record exists for {provider}")
    return connection


def embed_texts(
    texts: Iterable[str],
    connection: ConnectionRecord,
    *,
    trace_id: str | None = None,
    service: str = "workflow-runtime",
) -> list[list[float]]:
    text_batch = [text for text in texts if text.strip()]
    if not text_batch:
        return []
    provider_connection = _merge_provider_connection(connection)
    if not settings.app_embedding_cache_enabled:
        embed_model = _get_embed_model(provider_connection)

        def _run() -> list[list[float]]:
            return embed_model.get_text_embedding_batch(text_batch)

        if trace_id:
            return wrap_outbound_call(trace_id=trace_id, service=service, route="openai.embeddings", fn=_run)
        return _run()

    cached_vectors, namespace, stale_count = _load_cached_embeddings(provider_connection, text_batch)
    unique_missing_texts: list[str] = []
    seen_missing_hashes: set[str] = set()
    for text in text_batch:
        text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if text_hash in cached_vectors or text_hash in seen_missing_hashes:
            continue
        unique_missing_texts.append(text)
        seen_missing_hashes.add(text_hash)

    if trace_id:
        log_instant_event(
            trace_id=trace_id,
            service=service,
            route="embedding_cache.lookup",
            status="ok",
            details={
                "provider": namespace[0],
                "base_url": namespace[1],
                "embedding_model": namespace[2],
                "requested": len(text_batch),
                "hits": len(cached_vectors),
                "misses": len(unique_missing_texts),
                "stale_evicted": stale_count,
            },
        )

    missing_vectors_by_hash: dict[str, list[float]] = {}
    if unique_missing_texts:
        embed_model = _get_embed_model(provider_connection)

        def _run() -> list[list[float]]:
            return embed_model.get_text_embedding_batch(unique_missing_texts)

        new_vectors = (
            wrap_outbound_call(trace_id=trace_id, service=service, route="openai.embeddings", fn=_run)
            if trace_id
            else _run()
        )
        to_store: list[tuple[str, list[float]]] = []
        for text, vector in zip(unique_missing_texts, new_vectors, strict=True):
            text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
            missing_vectors_by_hash[text_hash] = vector
            to_store.append((text, vector))
        _store_cached_embeddings(namespace, to_store)
        if trace_id:
            log_instant_event(
                trace_id=trace_id,
                service=service,
                route="embedding_cache.store",
                status="ok",
                details={
                    "provider": namespace[0],
                    "base_url": namespace[1],
                    "embedding_model": namespace[2],
                    "stored": len(to_store),
                },
            )

    vectors_by_hash = {**cached_vectors, **missing_vectors_by_hash}
    return [vectors_by_hash[hashlib.sha256(text.encode("utf-8")).hexdigest()] for text in text_batch]


def generate_answer(
    prompt: str,
    connection: ConnectionRecord,
    *,
    api_mode: str = "responses",
    system_prompt: str = SYSTEM_PROMPT,
    model_id: str | None = None,
    temperature: float = 0,
    max_tokens: int | None = None,
    trace_id: str | None = None,
    service: str = "agent-ingress",
) -> str:
    provider_connection = _merge_provider_connection(connection)
    llm = _build_llm(
        provider_connection,
        model_id=model_id or provider_connection.chat_model,
        temperature=temperature,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
    )

    def _run() -> str:
        response = llm.complete(prompt)
        return getattr(response, "text", str(response)).strip()

    route = f"openai.{api_mode}"
    if trace_id:
        return wrap_outbound_call(trace_id=trace_id, service=service, route=route, fn=_run)
    return _run()


def stream_answer(
    prompt: str,
    connection: ConnectionRecord,
    *,
    api_mode: str = "responses",
    system_prompt: str = SYSTEM_PROMPT,
    model_id: str | None = None,
    temperature: float = 0,
    max_tokens: int | None = None,
    trace_id: str,
    service: str = "agent-ingress",
) -> Iterator[str]:
    provider_connection = _merge_provider_connection(connection)
    llm = _build_llm(
        provider_connection,
        model_id=model_id or provider_connection.chat_model,
        temperature=temperature,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
    )
    span_id = new_span_id()
    start_ts = time.time()
    error: str | None = None
    status: str = "ok"
    try:
        for chunk in llm.stream_complete(prompt):
            delta = getattr(chunk, "delta", None) or getattr(chunk, "text", None) or str(chunk)
            if delta:
                yield delta
    except Exception as exc:
        error = repr(exc)
        status = "error"
        raise
    finally:
        log_event(
            trace_id=trace_id,
            span_id=span_id,
            service=service,
            route=f"openai.{api_mode}.stream",
            start_ts=start_ts,
            end_ts=time.time(),
            status=status,
            error=error,
        )


def test_provider_connection(
    connection: ConnectionRecord,
    *,
    api_mode: str = "responses",
    prompt: str,
    trace_id: str | None = None,
    service: str = "control-api",
    api_key: str | None = None,
    base_url: str | None = None,
    chat_model: str | None = None,
) -> dict[str, str]:
    provider_connection = _merge_provider_connection(
        connection,
        api_key=api_key,
        base_url=base_url,
        chat_model=chat_model,
    )

    def _run() -> dict[str, str]:
        llm = _get_llm(provider_connection)
        response = llm.complete(prompt)
        return {
            "api_mode": api_mode,
            "model": _normalize_provider_model_id(
                provider_connection.provider,
                provider_connection.chat_model,
                settings.app_default_chat_model,
            ),
            "base_url": _provider_base_url(provider_connection),
            "output": getattr(response, "text", str(response)).strip(),
        }

    route = f"openai.test.{api_mode}"
    if trace_id:
        return wrap_outbound_call(trace_id=trace_id, service=service, route=route, fn=_run)
    return _run()
