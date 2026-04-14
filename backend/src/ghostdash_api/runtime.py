from __future__ import annotations

import hashlib
import time
from typing import Any
from datetime import UTC, datetime, timedelta
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
from openai import OpenAI as OpenAIClient
from llama_index.embeddings.openai import OpenAIEmbedding
from llama_index.embeddings.openai.base import OpenAIEmbeddingModelType
from llama_index.llms.openai import OpenAI as LlamaIndexOpenAI
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import ConnectionRecord, EmbeddingCacheRecord
from .runtime_profiles import DEFAULT_SYSTEM_PROMPT
from .settings import get_settings
from .telemetry import log_event, log_instant_event, new_span_id, wrap_outbound_call

settings = get_settings()
SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT
OPENAI_EMBEDDING_MODEL_VALUES = frozenset(model.value for model in OpenAIEmbeddingModelType)
OPENAI_EMBEDDING_VALIDATION_MODEL = OpenAIEmbeddingModelType.TEXT_EMBED_ADA_002.value


@dataclass(slots=True)
class LlmCompletionResult:
    """Result of a single LLM call; `openai_response_id` is set for native OpenAI Responses API."""

    text: str
    openai_response_id: str | None = None


@dataclass(slots=True)
class ProviderConnectionConfig:
    provider: str
    label: str
    api_key: str | None
    base_url: str | None
    provider_kind: str = "openai"
    auth_strategy: str = "bearer"
    auth_header_name: str | None = None


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
    provider_kind: str | None = None,
    auth_strategy: str | None = None,
    auth_header_name: str | None = None,
) -> ProviderConnectionConfig:
    return ProviderConnectionConfig(
        provider=connection.provider,
        label=connection.label,
        provider_kind=provider_kind or connection.provider_kind or "openai",
        auth_strategy=auth_strategy or connection.auth_strategy or "bearer",
        auth_header_name=auth_header_name if auth_header_name is not None else connection.auth_header_name,
        api_key=api_key if api_key not in (None, "") else connection.api_key,
        base_url=base_url if base_url not in (None, "") else connection.base_url,
    )


def _provider_api_key(connection: ProviderConnectionConfig) -> str:
    api_key = connection.api_key or settings.openai_api_key
    if not api_key:
        raise ValueError("No API key configured for the selected provider connection")
    return api_key


def _normalize_openai_compatible_base_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    for suffix in ("/chat/completions", "/responses", "/completions", "/embeddings"):
        if normalized.endswith(suffix):
            return normalized[: -len(suffix)]
    return normalized


def _provider_base_url(connection: ProviderConnectionConfig) -> str:
    return _normalize_openai_compatible_base_url(connection.base_url or settings.openai_base_url)


def _provider_default_headers(connection: ProviderConnectionConfig) -> dict[str, str] | None:
    auth_strategy = (connection.auth_strategy or "bearer").strip().lower()
    if auth_strategy == "x_api_key":
        return {"x-api-key": _provider_api_key(connection)}
    if auth_strategy == "x_goog_api_key":
        return {"x-goog-api-key": _provider_api_key(connection)}
    if auth_strategy == "custom_header":
        header_name = (connection.auth_header_name or "").strip() or "X-API-Key"
        return {header_name: _provider_api_key(connection)}
    base_url = _provider_base_url(connection)
    parsed = urlsplit(base_url)
    hostname = (parsed.hostname or "").lower()
    path = parsed.path.rstrip("/")
    if hostname == "one.rideai.com.au" and path.endswith("/api/llamaindex/v1"):
        return {"X-Internal-Key": _provider_api_key(connection)}
    return None


def _is_gemini_openai_compat_base_url(base_url: str) -> bool:
    parsed = urlsplit(base_url.rstrip("/"))
    hostname = (parsed.hostname or "").lower()
    path = (parsed.path or "").rstrip("/")
    return hostname == "generativelanguage.googleapis.com" and path.endswith("/v1beta/openai")


def _is_gemini_native_base_url(base_url: str) -> bool:
    normalized = _normalize_gemini_native_base_url(base_url)
    parsed = urlsplit(normalized.rstrip("/"))
    hostname = (parsed.hostname or "").lower()
    path = (parsed.path or "").rstrip("/")
    # Native REST base: .../v1beta
    # Note: OpenAI compatibility base is .../v1beta/openai (handled separately).
    return hostname == "generativelanguage.googleapis.com" and path.endswith("/v1beta")


def _normalize_gemini_native_base_url(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    # Some users paste .../v1beta/models/...
    if normalized.endswith("/v1beta/models"):
        return normalized[: -len("/models")]
    if "/v1beta/models/" in normalized:
        return normalized.split("/v1beta/models/", 1)[0] + "/v1beta"
    return normalized


def _normalize_gemini_model_id(model_id: str) -> str:
    model = (model_id or "").strip()
    if not model:
        return ""
    if model.startswith("models/"):
        model = model.split("/", 1)[1]
    return model


def _gemini_native_auth_headers(connection: ProviderConnectionConfig) -> dict[str, str]:
    strategy = (connection.auth_strategy or "bearer").strip().lower()
    api_key = _provider_api_key(connection)
    if strategy == "bearer":
        return {"Authorization": f"Bearer {api_key}"}
    if strategy == "x_api_key":
        # Common misconfiguration: users expect x_api_key to mean x-goog-api-key.
        return {"x-goog-api-key": api_key}
    headers = _provider_default_headers(connection) or {}
    return dict(headers)


def _gemini_generate_content(
    connection: ProviderConnectionConfig,
    *,
    prompt: str,
    model_id: str,
) -> str:
    base_url = _normalize_gemini_native_base_url(_provider_base_url(connection))
    model = _normalize_gemini_model_id(model_id)
    if not model:
        raise ValueError("Gemini model id is required (e.g. gemini-flash-latest)")
    url = f"{base_url}/models/{model}:generateContent"
    headers = {"Content-Type": "application/json", **_gemini_native_auth_headers(connection)}
    body = {"contents": [{"parts": [{"text": prompt}]}]}
    timeout = float(getattr(settings, "app_llm_request_timeout_seconds", 120.0))
    with httpx.Client(timeout=timeout) as client:
        response = client.post(url, headers=headers, json=body)
        if response.status_code >= 400:
            raise ValueError(f"Gemini generateContent failed ({response.status_code}): {response.text[:800]}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise ValueError(f"Gemini generateContent returned non-JSON: {response.text[:800]}") from exc
    candidates = payload.get("candidates") or []
    content = (candidates[0] or {}).get("content") if candidates else None
    parts = (content or {}).get("parts") if isinstance(content, dict) else None
    if isinstance(parts, list):
        texts = [str(part.get("text", "")) for part in parts if isinstance(part, dict) and part.get("text")]
        out = "".join(texts).strip()
        if out:
            return out
    # Fallback: some responses include output under different keys; surface entire payload.
    raise ValueError(f"Gemini generateContent returned no text: {payload!r}")


def _uses_rideai_chat_gateway(connection: ProviderConnectionConfig) -> bool:
    base_url = _provider_base_url(connection)
    parsed = urlsplit(base_url)
    hostname = (parsed.hostname or "").lower()
    path = parsed.path.rstrip("/")
    return hostname == "one.rideai.com.au" and path.endswith("/api/llamaindex/v1")


def should_use_openai_responses_chain(connection: ConnectionRecord, api_mode: str) -> bool:
    """Use OpenAI /v1/responses with previous_response_id (no pasted history) when applicable."""
    if api_mode != "responses":
        return False
    pc = _merge_provider_connection(connection)
    if _uses_rideai_chat_gateway(pc):
        return False
    if (pc.provider_kind or "openai").lower() != "openai":
        return False
    host = (urlsplit(_provider_base_url(pc)).hostname or "").lower()
    return host == "api.openai.com"


def _build_openai_compatible_client(connection: ProviderConnectionConfig) -> OpenAIClient:
    return OpenAIClient(
        api_key=_provider_api_key(connection),
        base_url=_provider_base_url(connection),
        default_headers=_provider_default_headers(connection),
        timeout=settings.app_llm_request_timeout_seconds,
    )


def _embedding_provider_base_url(connection: ProviderConnectionConfig) -> str:
    configured = settings.openai_embedding_base_url
    if configured:
        return configured.rstrip("/")
    return _provider_base_url(connection)


def _embedding_provider_api_key(connection: ProviderConnectionConfig) -> str:
    configured = settings.openai_embedding_api_key
    if configured:
        return configured
    embedding_base = _embedding_provider_base_url(connection)
    if embedding_base != _provider_base_url(connection):
        # Local TEI does not require auth, but the OpenAI client still expects a placeholder key.
        return "local-tei"
    return _provider_api_key(connection)


def _embedding_base_uses_custom_endpoint(base_url: str) -> bool:
    return (urlsplit(base_url).hostname or "").lower() != "api.openai.com"


def _should_use_custom_embedding_model_name(connection: ProviderConnectionConfig, model: str) -> bool:
    return (
        model not in OPENAI_EMBEDDING_MODEL_VALUES
        and _embedding_base_uses_custom_endpoint(_embedding_provider_base_url(connection))
    )


def _get_llm(connection: ProviderConnectionConfig, *, model_id: str | None = None) -> LlamaIndexOpenAI:
    return _build_llm(
        connection,
        model_id=model_id,
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
        default_headers=_provider_default_headers(connection),
        temperature=temperature,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
    )


def _coerce_content_fragment_to_text(fragment: Any) -> str:
    if fragment is None:
        return ""
    if isinstance(fragment, str):
        return fragment
    if isinstance(fragment, (int, float, bool)):
        return str(fragment)
    if isinstance(fragment, (list, tuple)):
        return "".join(_coerce_content_fragment_to_text(item) for item in fragment)
    if isinstance(fragment, dict):
        for key in ("text", "content", "delta", "value"):
            if key in fragment:
                return _coerce_content_fragment_to_text(fragment.get(key))
        return ""
    for attr in ("text", "content", "delta", "value"):
        if hasattr(fragment, attr):
            return _coerce_content_fragment_to_text(getattr(fragment, attr))
    return ""


def _get_embed_model(connection: ProviderConnectionConfig, *, embedding_model: str | None = None) -> OpenAIEmbedding:
    model = _normalize_provider_model_id(
        connection.provider,
        embedding_model,
        settings.app_default_embedding_model,
    )
    embed_kwargs = {
        "api_key": _embedding_provider_api_key(connection),
        "api_base": _embedding_provider_base_url(connection),
        "embed_batch_size": max(1, settings.app_embedding_batch_size),
    }
    if _should_use_custom_embedding_model_name(connection, model):
        # LlamaIndex validates `model` against OpenAI enums before making the request,
        # so custom TEI-served models need to be passed via `model_name` instead.
        embed_kwargs["model"] = OPENAI_EMBEDDING_VALIDATION_MODEL
        embed_kwargs["model_name"] = model
    else:
        embed_kwargs["model"] = model
    return OpenAIEmbedding(**embed_kwargs)


def _iter_embedding_text_batches(texts: list[str]) -> Iterator[list[str]]:
    batch_size = max(1, settings.app_embedding_batch_size)
    for start in range(0, len(texts), batch_size):
        yield texts[start : start + batch_size]


def _request_embeddings_in_batches(
    embed_model: OpenAIEmbedding,
    texts: list[str],
    *,
    trace_id: str | None = None,
    service: str = "workflow-runtime",
) -> list[list[float]]:
    vectors: list[list[float]] = []
    for batch in _iter_embedding_text_batches(texts):
        def _run(current_batch: list[str] = batch) -> list[list[float]]:
            return embed_model.get_text_embedding_batch(current_batch)

        batch_vectors = (
            wrap_outbound_call(trace_id=trace_id, service=service, route="openai.embeddings", fn=_run)
            if trace_id
            else _run()
        )
        vectors.extend(batch_vectors)
    return vectors


def _embedding_cache_key(
    connection: ProviderConnectionConfig,
    text: str,
    *,
    embedding_model: str | None = None,
) -> tuple[str, str, str, str]:
    model = _normalize_provider_model_id(
        connection.provider,
        embedding_model,
        settings.app_default_embedding_model,
    )
    text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return connection.provider, _embedding_provider_base_url(connection), model, text_hash


def _embedding_cache_cutoff() -> datetime | None:
    ttl_seconds = settings.app_embedding_cache_ttl_seconds
    if ttl_seconds <= 0:
        return None
    return datetime.now(UTC) - timedelta(seconds=ttl_seconds)


def _cache_row_is_stale(updated_at: datetime, cutoff: datetime | None) -> bool:
    if cutoff is None:
        return False
    candidate = updated_at if updated_at.tzinfo is not None else updated_at.replace(tzinfo=UTC)
    return candidate < cutoff


def _load_cached_embeddings(
    connection: ProviderConnectionConfig,
    text_batch: list[str],
    *,
    embedding_model: str | None = None,
) -> tuple[dict[str, list[float]], tuple[str, str, str], int]:
    provider, base_url, model, _ = _embedding_cache_key(connection, text_batch[0], embedding_model=embedding_model)
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
            if _cache_row_is_stale(row.updated_at, cutoff):
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
            "provider_kind": "openai",
            "auth_strategy": "bearer",
            "auth_header_name": None,
            "api_key": settings.openai_api_key,
            "base_url": settings.openai_base_url,
            "enabled": bool(settings.openai_api_key),
        },
        "google-gemini": {
            "label": "Google Gemini",
            "provider_kind": "google_gemini",
            "auth_strategy": "x_goog_api_key",
            "auth_header_name": None,
            "api_key": None,
            "base_url": "https://generativelanguage.googleapis.com/v1beta",
            "enabled": False,
        },
    }
    for provider, payload in defaults.items():
        existing = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == provider))
        if existing:
            if provider == "openai" and settings.openai_api_key and not existing.api_key:
                existing.api_key = settings.openai_api_key
                existing.enabled = True
            existing.base_url = existing.base_url or payload["base_url"]
            existing.provider_kind = existing.provider_kind or payload["provider_kind"]
            existing.auth_strategy = existing.auth_strategy or payload["auth_strategy"]
            if existing.auth_header_name is None:
                existing.auth_header_name = payload["auth_header_name"]
            continue
        session.add(ConnectionRecord(provider=provider, **payload))
    session.commit()


def list_connections(session: Session) -> list[ConnectionRecord]:
    return list(session.scalars(select(ConnectionRecord).order_by(ConnectionRecord.provider)))


def save_connection(session: Session, provider: str, **fields) -> ConnectionRecord:
    record = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == provider))
    if record is None:
        record = ConnectionRecord(
            provider=provider,
            label=fields.get("label") or provider.title(),
            provider_kind=fields.get("provider_kind") or ("openai" if provider == "openai" else "openai_compatible"),
            auth_strategy=fields.get("auth_strategy") or "bearer",
            auth_header_name=fields.get("auth_header_name"),
        )
        session.add(record)

    for key, value in fields.items():
        if key == "api_key" and value in (None, ""):
            continue
        setattr(record, key, value)

    if provider == "openai":
        record.base_url = record.base_url or settings.openai_base_url
        record.provider_kind = record.provider_kind or "openai"

    if record.provider_kind == "openai_compatible" and record.auth_strategy == "custom_header":
        record.auth_header_name = (record.auth_header_name or "X-API-Key").strip() or "X-API-Key"

    session.commit()
    session.refresh(record)
    return record


def get_connection(session: Session, connection_id: str) -> ConnectionRecord:
    connection = session.get(ConnectionRecord, connection_id)
    if connection is None:
        raise ValueError(f"connection {connection_id} not found")
    return connection


def get_active_connection(session: Session, provider: str = "openai") -> ConnectionRecord:
    connection = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == provider))
    if connection is None:
        raise ValueError(f"No connection record exists for {provider}")
    return connection


def resolve_llm_connection(
    session: Session,
    *,
    connection_id: str | None = None,
    provider: str | None = None,
    fallback_provider: str = "openai",
) -> ConnectionRecord:
    if connection_id:
        return get_connection(session, connection_id)
    if provider:
        return get_active_connection(session, provider)
    return get_active_connection(session, fallback_provider)


def embed_texts(
    texts: Iterable[str],
    connection: ConnectionRecord,
    *,
    embedding_model: str | None = None,
    trace_id: str | None = None,
    service: str = "workflow-runtime",
) -> list[list[float]]:
    text_batch = [text for text in texts if text.strip()]
    if not text_batch:
        return []
    provider_connection = _merge_provider_connection(connection)
    if not settings.app_embedding_cache_enabled:
        embed_model = _get_embed_model(provider_connection, embedding_model=embedding_model)
        return _request_embeddings_in_batches(embed_model, text_batch, trace_id=trace_id, service=service)

    cached_vectors, namespace, stale_count = _load_cached_embeddings(
        provider_connection,
        text_batch,
        embedding_model=embedding_model,
    )
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
        embed_model = _get_embed_model(provider_connection, embedding_model=embedding_model)
        new_vectors = _request_embeddings_in_batches(
            embed_model,
            unique_missing_texts,
            trace_id=trace_id,
            service=service,
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
    previous_response_id: str | None = None,
    use_openai_responses_http: bool = False,
) -> LlmCompletionResult:
    provider_connection = _merge_provider_connection(connection)
    resolved_model = _normalize_provider_model_id(provider_connection.provider, model_id, settings.app_default_chat_model)

    base_url = _provider_base_url(provider_connection)
    if (provider_connection.provider_kind or "").strip().lower() == "google_gemini" and _is_gemini_native_base_url(base_url):

        def _run() -> LlmCompletionResult:
            text = _gemini_generate_content(provider_connection, prompt=prompt, model_id=resolved_model)
            return LlmCompletionResult(text=text.strip(), openai_response_id=None)

        if trace_id:
            return wrap_outbound_call(trace_id=trace_id, service=service, route="gemini.generateContent", fn=_run)
        return _run()

    if _uses_rideai_chat_gateway(provider_connection):
        client = _build_openai_compatible_client(provider_connection)

        def _run() -> LlmCompletionResult:
            response = client.chat.completions.create(
                model=resolved_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
                stream=False,
            )
            content = response.choices[0].message.content if response.choices else ""
            return LlmCompletionResult(text=_coerce_content_fragment_to_text(content).strip(), openai_response_id=None)

    elif use_openai_responses_http:
        client = _build_openai_compatible_client(provider_connection)

        def _run() -> LlmCompletionResult:
            instr = (system_prompt or "").strip() or "You are a helpful assistant."
            kwargs: dict = {
                "model": resolved_model,
                "instructions": instr,
                "input": prompt,
                "temperature": temperature,
            }
            if max_tokens is not None:
                kwargs["max_output_tokens"] = max_tokens
            if previous_response_id:
                kwargs["previous_response_id"] = previous_response_id
            resp = client.responses.create(**kwargs)
            text = (getattr(resp, "output_text", None) or "").strip()
            return LlmCompletionResult(text=text, openai_response_id=getattr(resp, "id", None))

    else:
        llm = _build_llm(
            provider_connection,
            model_id=model_id,
            temperature=temperature,
            max_tokens=max_tokens,
            system_prompt=system_prompt,
        )

        def _run() -> LlmCompletionResult:
            response = llm.complete(prompt)
            out = getattr(response, "text", str(response)).strip()
            return LlmCompletionResult(text=out, openai_response_id=None)

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
    previous_response_id: str | None = None,
    use_openai_responses_http: bool = False,
    openai_response_id_out: list[str | None] | None = None,
) -> Iterator[str]:
    provider_connection = _merge_provider_connection(connection)
    resolved_model = _normalize_provider_model_id(provider_connection.provider, model_id, settings.app_default_chat_model)
    span_id = new_span_id()
    start_ts = time.time()
    error: str | None = None
    status: str = "ok"
    try:
        base_url = _provider_base_url(provider_connection)
        if (provider_connection.provider_kind or "").strip().lower() == "google_gemini" and _is_gemini_native_base_url(base_url):
            # Native Gemini does not currently support token-delta streaming through this path.
            # We still stream by yielding the completed answer once (or in a few chunks).
            text = _gemini_generate_content(provider_connection, prompt=prompt, model_id=resolved_model).strip()
            if text:
                chunk_size = 240
                for i in range(0, len(text), chunk_size):
                    yield text[i : i + chunk_size]
            return

        if _uses_rideai_chat_gateway(provider_connection):
            client = _build_openai_compatible_client(provider_connection)
            stream = client.chat.completions.create(
                model=resolved_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
            )
            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = _coerce_content_fragment_to_text(chunk.choices[0].delta.content)
                if delta:
                    yield delta
        elif use_openai_responses_http:
            client = _build_openai_compatible_client(provider_connection)
            instr = (system_prompt or "").strip() or "You are a helpful assistant."
            kwargs: dict = {
                "model": resolved_model,
                "instructions": instr,
                "input": prompt,
                "temperature": temperature,
                "stream": True,
            }
            if max_tokens is not None:
                kwargs["max_output_tokens"] = max_tokens
            if previous_response_id:
                kwargs["previous_response_id"] = previous_response_id
            stream = client.responses.create(**kwargs)
            for event in stream:
                et = getattr(event, "type", None)
                if et == "response.output_text.delta":
                    delta = _coerce_content_fragment_to_text(getattr(event, "delta", ""))
                    if delta:
                        yield delta
                elif et == "response.completed":
                    resp_obj = getattr(event, "response", None)
                    rid = getattr(resp_obj, "id", None) if resp_obj is not None else None
                    if openai_response_id_out is not None and len(openai_response_id_out) > 0:
                        openai_response_id_out[0] = rid
        else:
            llm = _build_llm(
                provider_connection,
                model_id=model_id,
                temperature=temperature,
                max_tokens=max_tokens,
                system_prompt=system_prompt,
            )
            for chunk in llm.stream_complete(prompt):
                delta = _coerce_content_fragment_to_text(
                    getattr(chunk, "delta", None) or getattr(chunk, "text", None) or chunk
                )
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


def stream_answer_to_result(
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
    previous_response_id: str | None = None,
    use_openai_responses_http: bool = False,
) -> LlmCompletionResult:
    holder: list[str | None] = [None]
    parts: list[str] = []
    for delta in stream_answer(
        prompt,
        connection,
        api_mode=api_mode,
        system_prompt=system_prompt,
        model_id=model_id,
        temperature=temperature,
        max_tokens=max_tokens,
        trace_id=trace_id,
        service=service,
        previous_response_id=previous_response_id,
        use_openai_responses_http=use_openai_responses_http,
        openai_response_id_out=holder,
    ):
        parts.append(delta)
    return LlmCompletionResult(text="".join(parts).strip(), openai_response_id=holder[0] if holder else None)


def test_provider_connection(
    connection: ConnectionRecord,
    *,
    api_mode: str = "responses",
    prompt: str,
    trace_id: str | None = None,
    service: str = "control-api",
    api_key: str | None = None,
    base_url: str | None = None,
    model_id: str | None = None,
) -> dict[str, str]:
    provider_connection = _merge_provider_connection(
        connection,
        api_key=api_key,
        base_url=base_url,
    )
    resolved_model = _normalize_provider_model_id(
        provider_connection.provider,
        model_id,
        settings.app_default_chat_model,
    )

    def _run() -> dict[str, str]:
        base = _provider_base_url(provider_connection)
        if (provider_connection.provider_kind or "").strip().lower() == "google_gemini" and _is_gemini_native_base_url(base):
            output = _gemini_generate_content(provider_connection, prompt=prompt, model_id=resolved_model)
            return {
                "api_mode": api_mode,
                "model": resolved_model,
                "base_url": base,
                "output": output.strip(),
            }
        if _uses_rideai_chat_gateway(provider_connection):
            client = _build_openai_compatible_client(provider_connection)
            response = client.chat.completions.create(
                model=resolved_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                stream=False,
            )
            output = (response.choices[0].message.content if response.choices else "") or ""
        else:
            llm = _get_llm(provider_connection, model_id=model_id)
            response = llm.complete(prompt)
            output = getattr(response, "text", str(response)).strip()
        return {
            "api_mode": api_mode,
            "model": resolved_model,
            "base_url": _provider_base_url(provider_connection),
            "output": output.strip(),
        }

    route = f"openai.test.{api_mode}"
    if trace_id:
        return wrap_outbound_call(trace_id=trace_id, service=service, route=route, fn=_run)
    return _run()
