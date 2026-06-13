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
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import SessionLocal
from .models import ConnectionRecord, EmbeddingCacheRecord
from .runtime_profiles import DEFAULT_SYSTEM_PROMPT
from .settings import get_settings
from .telemetry import log_event, log_instant_event, new_span_id, wrap_outbound_call
from .token_usage import normalize_provider_usage_dict

settings = get_settings()
SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT


@dataclass(slots=True)
class LlmCompletionResult:
    """Result of a single LLM call; `openai_response_id` is set for native OpenAI Responses API."""

    text: str
    openai_response_id: str | None = None
    usage: dict[str, int | bool] | None = None


@dataclass(slots=True)
class ProviderConnectionConfig:
    provider: str
    label: str
    api_key: str | None
    base_url: str | None
    provider_kind: str = "openai"
    auth_strategy: str = "bearer"
    auth_header_name: str | None = None
    aws_region: str | None = None


def _normalize_provider_model_id(
    provider: str,
    model_id: str | None,
    fallback: str,
    *,
    provider_kind: str | None = None,
) -> str:
    model = (model_id or fallback or "").strip()
    # Strip `openai/` prefix for any OpenAI-family provider (openai, openai-staging, …) so outbound
    # model ids match provider catalogs (same behavior as native OpenAI).
    p = (provider or "").strip().lower()
    kind = (provider_kind or "").strip().lower()
    if p.startswith("openai") or kind in {"openai", "openai_compatible"}:
        lowered = model.lower()
        if lowered.startswith("openai/"):
            model = model.split("/", 1)[1]
            lowered = model.lower()
        if lowered.startswith("model/"):
            model = model.split("/", 1)[1]
        model = model.lstrip("/")
        # Native OpenAI catalogs are lowercase; self-hosted gateways often expose case-sensitive
        # custom ids (for example `RE-JH-LLM05`) so only normalize native OpenAI providers.
        if kind == "openai" and model and model.upper() == model:
            model = model.lower()
    if kind == "anthropic":
        lowered = model.lower()
        if lowered.startswith("anthropic/"):
            model = model.split("/", 1)[1]
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
        aws_region=getattr(connection, "aws_region", None),
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


def _normalize_rideai_gateway_base_url(base_url: str) -> str:
    normalized = _normalize_openai_compatible_base_url(base_url)
    parsed = urlsplit(normalized.rstrip("/"))
    if (parsed.hostname or "").lower() != "one.rideai.com.au":
        return normalized
    path = (parsed.path or "").rstrip("/")
    if not path:
        return f"{parsed.scheme}://{parsed.netloc}/v1"
    return normalized


def _provider_base_url(connection: ProviderConnectionConfig) -> str:
    raw = connection.base_url or settings.openai_base_url
    return _normalize_rideai_gateway_base_url(raw)


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
    if hostname == "one.rideai.com.au" and (path.endswith("/api/llamaindex/v1") or path.endswith("/v1")):
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


def _gemini_generate_content_result(
    connection: ProviderConnectionConfig,
    *,
    prompt: str,
    model_id: str,
) -> LlmCompletionResult:
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
    texts = [str(part.get("text", "")) for part in parts if isinstance(part, dict) and part.get("text")] if isinstance(parts, list) else []
    text = "".join(texts).strip()
    if not text:
        raise ValueError(f"Gemini generateContent returned no text: {payload!r}")
    usage_metadata = payload.get("usageMetadata") if isinstance(payload, dict) else None
    usage = (
        normalize_provider_usage_dict(
            prompt_tokens=usage_metadata.get("promptTokenCount") if isinstance(usage_metadata, dict) else None,
            completion_tokens=usage_metadata.get("candidatesTokenCount") if isinstance(usage_metadata, dict) else None,
            total_tokens=usage_metadata.get("totalTokenCount") if isinstance(usage_metadata, dict) else None,
        )
        if isinstance(usage_metadata, dict)
        else None
    )
    return LlmCompletionResult(text=text, openai_response_id=None, usage=usage)


# ---------------------------------------------------------------------------
# Amazon Bedrock Converse helpers
# ---------------------------------------------------------------------------

def _bedrock_client(connection: ProviderConnectionConfig):
    """Build a boto3 bedrock-runtime client from connection credentials."""
    import boto3  # local import: only needed when amazon_bedrock provider is used
    region = (getattr(connection, "aws_region", None) or "").strip() or settings.aws_default_region
    # auth_header_name stores AWS Access Key ID; api_key stores AWS Secret Access Key.
    access_key_id = (connection.auth_header_name or "").strip() or settings.aws_access_key_id
    secret_access_key = (connection.api_key or "").strip() or settings.aws_secret_access_key
    kwargs: dict = {"region_name": region}
    if access_key_id:
        kwargs["aws_access_key_id"] = access_key_id
    if secret_access_key:
        kwargs["aws_secret_access_key"] = secret_access_key
    return boto3.client("bedrock-runtime", **kwargs)


def _bedrock_control_client(
    *,
    access_key_id: str | None = None,
    secret_access_key: str | None = None,
    region: str | None = None,
):
    """Build a boto3 bedrock (control-plane) client for listing models / profiles."""
    import boto3  # local import
    resolved_region = (region or "").strip() or settings.aws_default_region
    resolved_key = (access_key_id or "").strip() or settings.aws_access_key_id
    resolved_secret = (secret_access_key or "").strip() or settings.aws_secret_access_key
    kwargs: dict = {"region_name": resolved_region}
    if resolved_key:
        kwargs["aws_access_key_id"] = resolved_key
    if resolved_secret:
        kwargs["aws_secret_access_key"] = resolved_secret
    return boto3.client("bedrock", **kwargs)


def list_bedrock_available_models(
    *,
    access_key_id: str | None = None,
    secret_access_key: str | None = None,
    region: str | None = None,
) -> list[dict]:
    """
    Return merged list of enabled foundation models + inference profiles from Bedrock.
    Each item: {model_id, model_name, provider, kind, status}
    """
    client = _bedrock_control_client(
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        region=region,
    )
    results: list[dict] = []

    # Foundation models that the account has access to.
    try:
        paginator = client.get_paginator("list_foundation_models")
        for page in paginator.paginate():
            for m in page.get("modelSummaries", []):
                model_id = m.get("modelId", "")
                if not model_id:
                    continue
                results.append({
                    "model_id": model_id,
                    "model_name": m.get("modelName", model_id),
                    "provider": m.get("providerName", ""),
                    "kind": "foundation_model",
                    "input_modalities": m.get("inputModalities", []),
                    "output_modalities": m.get("outputModalities", []),
                    "status": "ACTIVE",
                })
    except Exception:  # noqa: BLE001
        pass  # may not have bedrock:ListFoundationModels permission

    # System-defined cross-region inference profiles (us.*, ap.*, eu.* prefixes).
    # Custom inference profiles created by the account.
    try:
        paginator = client.get_paginator("list_inference_profiles")
        for page in paginator.paginate():
            for p in page.get("inferenceProfileSummaries", []):
                profile_id = p.get("inferenceProfileId", "") or p.get("inferenceProfileArn", "")
                if not profile_id:
                    continue
                results.append({
                    "model_id": profile_id,
                    "model_name": p.get("inferenceProfileName", profile_id),
                    "provider": p.get("type", ""),
                    "kind": "inference_profile",
                    "input_modalities": [],
                    "output_modalities": [],
                    "status": p.get("status", "ACTIVE"),
                })
    except Exception:  # noqa: BLE001
        pass  # older SDK / permissions gap — profiles were added in boto3 1.34

    # Stable sort: inference profiles first (more likely what operator wants), then foundation models.
    results.sort(key=lambda item: (0 if item["kind"] == "inference_profile" else 1, item.get("model_name", "")))
    return results


def _bedrock_converse_result(
    connection: ProviderConnectionConfig,
    *,
    prompt: str,
    model_id: str,
    system_prompt: str,
    temperature: float,
    max_tokens: int | None,
) -> LlmCompletionResult:
    client = _bedrock_client(connection)
    inference_config: dict[str, Any] = {
        "maxTokens": max_tokens if max_tokens is not None else 4096,
        "temperature": float(temperature),
    }
    response = client.converse(
        modelId=model_id,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        system=[{"text": (system_prompt or "").strip() or "You are a helpful assistant."}],
        inferenceConfig=inference_config,
    )
    output_message = response.get("output", {}).get("message", {})
    content_blocks = output_message.get("content", [])
    text = "".join(
        block["text"] for block in content_blocks if isinstance(block, dict) and "text" in block
    ).strip()
    if not text:
        raise ValueError(f"Bedrock converse returned no text: {response!r}")
    usage = response.get("usage", {})
    return LlmCompletionResult(
        text=text,
        openai_response_id=None,
        usage=normalize_provider_usage_dict(
            prompt_tokens=usage.get("inputTokens"),
            completion_tokens=usage.get("outputTokens"),
            total_tokens=usage.get("totalTokens"),
        ),
    )


def _bedrock_converse_stream(
    connection: ProviderConnectionConfig,
    *,
    prompt: str,
    model_id: str,
    system_prompt: str,
    temperature: float,
    max_tokens: int | None,
) -> Iterator[str]:
    """Yield text deltas from Bedrock converse_stream (Server-Sent Events)."""
    client = _bedrock_client(connection)
    inference_config: dict[str, Any] = {
        "maxTokens": max_tokens if max_tokens is not None else 4096,
        "temperature": float(temperature),
    }
    response = client.converse_stream(
        modelId=model_id,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        system=[{"text": (system_prompt or "").strip() or "You are a helpful assistant."}],
        inferenceConfig=inference_config,
    )
    for event in response.get("stream", []):
        delta = event.get("contentBlockDelta", {}).get("delta", {})
        chunk = delta.get("text", "")
        if chunk:
            yield chunk


ANTHROPIC_API_VERSION = "2023-06-01"


def _anthropic_base_url(connection: ProviderConnectionConfig) -> str:
    raw = connection.base_url or "https://api.anthropic.com/v1"
    normalized = raw.rstrip("/")
    if normalized.endswith("/messages"):
        return normalized[: -len("/messages")]
    return normalized


def _anthropic_auth_headers(connection: ProviderConnectionConfig) -> dict[str, str]:
    strategy = (connection.auth_strategy or "bearer").strip().lower()
    api_key = _provider_api_key(connection)
    if strategy == "custom_header":
        header_name = (connection.auth_header_name or "").strip() or "x-api-key"
        return {
            header_name: api_key,
            "anthropic-version": ANTHROPIC_API_VERSION,
            "Content-Type": "application/json",
        }
    return {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "Content-Type": "application/json",
    }


def _extract_anthropic_text(payload: dict[str, Any]) -> str:
    content = payload.get("content")
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text)
    return "".join(parts).strip()


def _extract_anthropic_usage(payload: dict[str, Any]) -> dict[str, int | bool] | None:
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        return None
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    total_tokens = None
    if isinstance(input_tokens, int) and isinstance(output_tokens, int):
        total_tokens = input_tokens + output_tokens
    return normalize_provider_usage_dict(
        prompt_tokens=input_tokens,
        completion_tokens=output_tokens,
        total_tokens=total_tokens,
    )


def _anthropic_messages_result(
    connection: ProviderConnectionConfig,
    *,
    prompt: str,
    model_id: str,
    system_prompt: str = SYSTEM_PROMPT,
    temperature: float = 0,
    max_tokens: int | None = None,
) -> LlmCompletionResult:
    url = f"{_anthropic_base_url(connection)}/messages"
    headers = _anthropic_auth_headers(connection)
    body: dict[str, Any] = {
        "model": model_id,
        "max_tokens": max_tokens if max_tokens is not None else 4096,
        "temperature": temperature,
        "system": (system_prompt or "").strip() or "You are a helpful assistant.",
        "messages": [{"role": "user", "content": prompt}],
    }
    timeout = float(getattr(settings, "app_llm_request_timeout_seconds", 120.0))
    with httpx.Client(timeout=timeout) as client:
        response = client.post(url, headers=headers, json=body)
        if response.status_code >= 400:
            raise ValueError(f"Anthropic messages failed ({response.status_code}): {response.text[:4000]}")
        payload = response.json()
    text = _extract_anthropic_text(payload)
    if not text:
        raise ValueError(f"Anthropic messages returned no text: {payload!r}")
    return LlmCompletionResult(
        text=text,
        openai_response_id=None,
        usage=_extract_anthropic_usage(payload),
    )


def _extract_openai_chat_usage(response: Any) -> dict[str, int | bool] | None:
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    if usage is None:
        return None
    return normalize_provider_usage_dict(
        prompt_tokens=getattr(usage, "prompt_tokens", None) if not isinstance(usage, dict) else usage.get("prompt_tokens"),
        completion_tokens=getattr(usage, "completion_tokens", None) if not isinstance(usage, dict) else usage.get("completion_tokens"),
        total_tokens=getattr(usage, "total_tokens", None) if not isinstance(usage, dict) else usage.get("total_tokens"),
    )


def _extract_openai_responses_usage(response: Any) -> dict[str, int | bool] | None:
    usage = getattr(response, "usage", None)
    if usage is None and isinstance(response, dict):
        usage = response.get("usage")
    if usage is None:
        return None
    prompt_tokens = getattr(usage, "input_tokens", None) if not isinstance(usage, dict) else usage.get("input_tokens")
    completion_tokens = getattr(usage, "output_tokens", None) if not isinstance(usage, dict) else usage.get("output_tokens")
    total_tokens = getattr(usage, "total_tokens", None) if not isinstance(usage, dict) else usage.get("total_tokens")
    if prompt_tokens is None and completion_tokens is None and total_tokens is None:
        prompt_tokens = getattr(usage, "prompt_tokens", None) if not isinstance(usage, dict) else usage.get("prompt_tokens")
        completion_tokens = getattr(usage, "completion_tokens", None) if not isinstance(usage, dict) else usage.get("completion_tokens")
    return normalize_provider_usage_dict(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )


def _uses_rideai_chat_gateway(connection: ProviderConnectionConfig) -> bool:
    base_url = _provider_base_url(connection)
    return _uses_rideai_internal_gateway_base_url(base_url)


def _is_openai_native_host(connection: ProviderConnectionConfig) -> bool:
    host = (urlsplit(_provider_base_url(connection)).hostname or "").lower()
    return host == "api.openai.com"


def _requires_openai_sdk_client(connection: ProviderConnectionConfig) -> bool:
    """Use the OpenAI SDK directly for gateways with custom model ids."""
    if _uses_rideai_chat_gateway(connection):
        return True
    kind = (connection.provider_kind or "openai").strip().lower()
    if kind == "openai_compatible":
        return True
    return not _is_openai_native_host(connection)


def _use_openai_responses_sdk(
    connection: ProviderConnectionConfig,
    *,
    api_mode: str,
    use_openai_responses_http: bool,
) -> bool:
    if use_openai_responses_http:
        return True
    if api_mode != "responses":
        return False
    if _uses_rideai_chat_gateway(connection):
        return False
    kind = (connection.provider_kind or "openai").strip().lower()
    if kind == "openai_compatible":
        return False
    return _is_openai_native_host(connection)


def _uses_rideai_internal_gateway_base_url(base_url: str) -> bool:
    parsed = urlsplit(base_url.rstrip("/"))
    return (parsed.hostname or "").lower() == "one.rideai.com.au"


def _uses_rideai_llamaindex_base_url(base_url: str) -> bool:
    """Backward-compatible alias for the RideAI internal OpenAI-compatible gateway."""
    return _uses_rideai_internal_gateway_base_url(base_url)


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
    embedding_base = _embedding_provider_base_url(connection)
    # RideAI gateway uses the same internal key as chat (and X-Internal-Key); do not use OPENAI_EMBEDDING_API_KEY=local-tei.
    if _uses_rideai_llamaindex_base_url(embedding_base):
        return _provider_api_key(connection)
    configured = settings.openai_embedding_api_key
    if configured:
        return configured
    if embedding_base != _provider_base_url(connection):
        # Local TEI does not require auth, but the OpenAI client still expects a placeholder key.
        return "local-tei"
    return _provider_api_key(connection)


def _build_embedding_client(connection: ProviderConnectionConfig) -> OpenAIClient:
    emb_base = _embedding_provider_base_url(connection)
    default_headers = None
    if _uses_rideai_internal_gateway_base_url(emb_base):
        default_headers = _provider_default_headers(connection)
    return OpenAIClient(
        api_key=_embedding_provider_api_key(connection),
        base_url=emb_base,
        default_headers=default_headers,
        timeout=settings.app_llm_request_timeout_seconds,
    )


def _responses_error_should_fallback_to_chat(exc: BaseException) -> bool:
    """True when a non-streaming or streaming /v1/responses call is likely to succeed on chat.completions."""
    if isinstance(exc, (httpx.TimeoutException, TimeoutError, OSError)):
        return True
    name = (type(exc).__name__ or "").lower()
    if "timeout" in name:
        return True
    text = f"{type(exc).__name__} {exc!r} {exc}".lower()
    if "504" in text:
        return True
    if "upstream" in text and "timeout" in text:
        return True
    if "upstream llm" in text:
        return True
    if "gateway" in text and "timeout" in text:
        return True
    return False


def _openai_stream_chat_completions_deltas(
    client: OpenAIClient,
    *,
    resolved_model: str,
    system_prompt: str,
    prompt: str,
    temperature: float,
    max_tokens: int | None,
    usage_out: list[dict[str, int | bool] | None] | None = None,
) -> Iterator[str]:
    kwargs: dict[str, Any] = {
        "model": resolved_model,
        "messages": [
            {"role": "system", "content": system_prompt or "You are a helpful assistant."},
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    stream = client.chat.completions.create(**kwargs)
    for chunk in stream:
        usage = _extract_openai_chat_usage(chunk)
        if usage is not None and usage_out is not None and len(usage_out) > 0:
            usage_out[0] = usage
        if not chunk.choices:
            continue
        delta = _coerce_content_fragment_to_text(chunk.choices[0].delta.content)
        if delta:
            yield delta


def _openai_chat_completions_result(
    client: OpenAIClient,
    *,
    resolved_model: str,
    system_prompt: str,
    prompt: str,
    temperature: float,
    max_tokens: int | None,
) -> LlmCompletionResult:
    kwargs: dict[str, Any] = {
        "model": resolved_model,
        "messages": [
            {"role": "system", "content": system_prompt or "You are a helpful assistant."},
            {"role": "user", "content": prompt},
        ],
        "temperature": temperature,
        "stream": False,
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    response = client.chat.completions.create(**kwargs)
    if isinstance(response, str):
        content = response
    else:
        content = response.choices[0].message.content if response.choices else ""
    return LlmCompletionResult(
        text=_coerce_content_fragment_to_text(content).strip(),
        openai_response_id=None,
        usage=_extract_openai_chat_usage(response),
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


def _iter_embedding_text_batches(texts: list[str]) -> Iterator[list[str]]:
    batch_size = max(1, settings.app_embedding_batch_size)
    for start in range(0, len(texts), batch_size):
        yield texts[start : start + batch_size]


def _request_embeddings_in_batches(
    connection: ProviderConnectionConfig,
    texts: list[str],
    *,
    embedding_model: str | None = None,
    trace_id: str | None = None,
    service: str = "workflow-runtime",
) -> list[list[float]]:
    client = _build_embedding_client(connection)
    model = _normalize_provider_model_id(
        connection.provider,
        embedding_model,
        settings.app_default_embedding_model,
        provider_kind=connection.provider_kind,
    )
    vectors: list[list[float]] = []
    for batch in _iter_embedding_text_batches(texts):
        def _run(current_batch: list[str] = batch) -> list[list[float]]:
            response = client.embeddings.create(model=model, input=current_batch)
            by_index = {item.index: item.embedding for item in response.data}
            return [by_index[index] for index in range(len(current_batch))]

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
        provider_kind=connection.provider_kind,
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
        "amazon-bedrock": {
            "label": "Amazon Bedrock",
            "provider_kind": "amazon_bedrock",
            # auth_header_name stores the AWS Access Key ID (no Bearer token needed).
            "auth_strategy": "custom_header",
            "auth_header_name": settings.aws_access_key_id or None,
            "api_key": settings.aws_secret_access_key or None,
            "base_url": None,
            "enabled": bool(settings.aws_access_key_id and settings.aws_secret_access_key),
            "aws_region": settings.aws_default_region,
        },
    }
    for provider, payload in defaults.items():
        existing = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == provider))
        if existing:
            if provider == "openai" and settings.openai_api_key and not existing.api_key:
                existing.api_key = settings.openai_api_key
                existing.enabled = True
            if provider == "amazon-bedrock":
                if settings.aws_access_key_id and not existing.auth_header_name:
                    existing.auth_header_name = settings.aws_access_key_id
                if settings.aws_secret_access_key and not existing.api_key:
                    existing.api_key = settings.aws_secret_access_key
                    existing.enabled = True
                if not getattr(existing, "aws_region", None):
                    existing.aws_region = settings.aws_default_region  # type: ignore[attr-defined]
            existing.base_url = existing.base_url or payload["base_url"]
            existing.provider_kind = existing.provider_kind or payload["provider_kind"]
            existing.auth_strategy = existing.auth_strategy or payload["auth_strategy"]
            if existing.auth_header_name is None:
                existing.auth_header_name = payload["auth_header_name"]
            continue
        session.add(ConnectionRecord(provider=provider, **{k: v for k, v in payload.items() if k != "aws_region"}))
        if provider == "amazon-bedrock" and payload.get("aws_region"):
            # aws_region is handled by schema_migrations; setattr after add to avoid FK timing issues.
            pass
    session.commit()
    # Patch aws_region on the bedrock record after commit (column added by schema_migrations).
    bedrock_record = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == "amazon-bedrock"))
    if bedrock_record and not getattr(bedrock_record, "aws_region", None) and settings.aws_default_region:
        bedrock_record.aws_region = settings.aws_default_region  # type: ignore[attr-defined]
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
        if key == "default_model_id" and value in (None, ""):
            record.default_model_id = None
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


def delete_connection(session: Session, connection_id: str) -> ConnectionRecord:
    record = session.get(ConnectionRecord, connection_id)
    if record is None:
        raise ValueError(f"connection {connection_id} not found")
    session.delete(record)
    session.commit()
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
        return _request_embeddings_in_batches(
            provider_connection,
            text_batch,
            embedding_model=embedding_model,
            trace_id=trace_id,
            service=service,
        )

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
        new_vectors = _request_embeddings_in_batches(
            provider_connection,
            unique_missing_texts,
            embedding_model=embedding_model,
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
    resolved_model = _normalize_provider_model_id(
        provider_connection.provider,
        model_id,
        settings.app_default_chat_model,
        provider_kind=provider_connection.provider_kind,
    )

    base_url = _provider_base_url(provider_connection)
    provider_kind = (provider_connection.provider_kind or "").strip().lower()
    if provider_kind == "amazon_bedrock":

        def _run_bedrock() -> LlmCompletionResult:
            return _bedrock_converse_result(
                provider_connection,
                prompt=prompt,
                model_id=resolved_model,
                system_prompt=system_prompt,
                temperature=temperature,
                max_tokens=max_tokens,
            )

        if trace_id:
            return wrap_outbound_call(trace_id=trace_id, service=service, route="bedrock.converse", fn=_run_bedrock)
        return _run_bedrock()
    if provider_kind == "anthropic":

        def _run_anthropic() -> LlmCompletionResult:
            return _anthropic_messages_result(
                provider_connection,
                prompt=prompt,
                model_id=resolved_model,
                system_prompt=system_prompt,
                temperature=temperature,
                max_tokens=max_tokens,
            )

        if trace_id:
            return wrap_outbound_call(trace_id=trace_id, service=service, route="anthropic.messages", fn=_run_anthropic)
        return _run_anthropic()
    if provider_kind == "google_gemini" and _is_gemini_native_base_url(base_url):

        def _run() -> LlmCompletionResult:
            return _gemini_generate_content_result(provider_connection, prompt=prompt, model_id=resolved_model)

        if trace_id:
            return wrap_outbound_call(trace_id=trace_id, service=service, route="gemini.generateContent", fn=_run)
        return _run()

    if _use_openai_responses_sdk(
        provider_connection,
        api_mode=api_mode,
        use_openai_responses_http=use_openai_responses_http,
    ):
        client = _build_openai_compatible_client(provider_connection)

        def _run() -> LlmCompletionResult:
            def _non_stream_chat_fallback() -> LlmCompletionResult:
                s = (system_prompt or "").strip() or "You are a helpful assistant."
                kwargs2: dict[str, Any] = {
                    "model": resolved_model,
                    "messages": [
                        {"role": "system", "content": s},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": temperature,
                    "stream": False,
                }
                if max_tokens is not None:
                    kwargs2["max_tokens"] = max_tokens
                response = client.chat.completions.create(**kwargs2)
                content = response.choices[0].message.content if response.choices else ""
                return LlmCompletionResult(
                    text=_coerce_content_fragment_to_text(content).strip(),
                    openai_response_id=None,
                    usage=_extract_openai_chat_usage(response),
                )

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
            try:
                resp = client.responses.create(**kwargs)
                text = (getattr(resp, "output_text", None) or "").strip()
                return LlmCompletionResult(
                    text=text,
                    openai_response_id=getattr(resp, "id", None),
                    usage=_extract_openai_responses_usage(resp),
                )
            except Exception as exc:  # noqa: BLE001 - classified below
                fb = bool(getattr(settings, "app_llm_responses_fallback_to_chat", True))
                if not fb or previous_response_id is not None or not _responses_error_should_fallback_to_chat(exc):
                    raise
                return _non_stream_chat_fallback()

    else:
        client = _build_openai_compatible_client(provider_connection)

        def _run() -> LlmCompletionResult:
            return _openai_chat_completions_result(
                client,
                resolved_model=resolved_model,
                system_prompt=system_prompt,
                prompt=prompt,
                temperature=temperature,
                max_tokens=max_tokens,
            )

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
    usage_out: list[dict[str, int | bool] | None] | None = None,
) -> Iterator[str]:
    provider_connection = _merge_provider_connection(connection)
    resolved_model = _normalize_provider_model_id(
        provider_connection.provider,
        model_id,
        settings.app_default_chat_model,
        provider_kind=provider_connection.provider_kind,
    )
    span_id = new_span_id()
    start_ts = time.time()
    error: str | None = None
    status: str = "ok"
    try:
        base_url = _provider_base_url(provider_connection)
        provider_kind = (provider_connection.provider_kind or "").strip().lower()
        if provider_kind == "amazon_bedrock":
            for chunk in _bedrock_converse_stream(
                provider_connection,
                prompt=prompt,
                model_id=resolved_model,
                system_prompt=system_prompt,
                temperature=temperature,
                max_tokens=max_tokens,
            ):
                yield chunk
            return
        if provider_kind == "anthropic":
            result = _anthropic_messages_result(
                provider_connection,
                prompt=prompt,
                model_id=resolved_model,
                system_prompt=system_prompt,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            if usage_out is not None and len(usage_out) > 0:
                usage_out[0] = result.usage
            text = result.text.strip()
            if text:
                chunk_size = 240
                for i in range(0, len(text), chunk_size):
                    yield text[i : i + chunk_size]
            return
        if provider_kind == "google_gemini" and _is_gemini_native_base_url(base_url):
            # Native Gemini does not currently support token-delta streaming through this path.
            # We still stream by yielding the completed answer once (or in a few chunks).
            result = _gemini_generate_content_result(provider_connection, prompt=prompt, model_id=resolved_model)
            if usage_out is not None and len(usage_out) > 0:
                usage_out[0] = result.usage
            text = result.text.strip()
            if text:
                chunk_size = 240
                for i in range(0, len(text), chunk_size):
                    yield text[i : i + chunk_size]
            return

        if _use_openai_responses_sdk(
            provider_connection,
            api_mode=api_mode,
            use_openai_responses_http=use_openai_responses_http,
        ):
            client = _build_openai_compatible_client(provider_connection)
            instr = (system_prompt or "").strip() or "You are a helpful assistant."
            try:
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
                        usage = _extract_openai_responses_usage(resp_obj)
                        if usage is not None and usage_out is not None and len(usage_out) > 0:
                            usage_out[0] = usage
            except Exception as exc:  # noqa: BLE001 - classified for fallback
                fb = bool(getattr(settings, "app_llm_responses_fallback_to_chat", True))
                if not fb or previous_response_id is not None or not _responses_error_should_fallback_to_chat(exc):
                    raise
                yield from _openai_stream_chat_completions_deltas(
                    client,
                    resolved_model=resolved_model,
                    system_prompt=instr,
                    prompt=prompt,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    usage_out=usage_out,
                )
        else:
            client = _build_openai_compatible_client(provider_connection)
            s = (system_prompt or "").strip() or "You are a helpful assistant."
            yield from _openai_stream_chat_completions_deltas(
                client,
                resolved_model=resolved_model,
                system_prompt=s,
                prompt=prompt,
                temperature=temperature,
                max_tokens=max_tokens,
                usage_out=usage_out,
            )
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
    usage_holder: list[dict[str, int | bool] | None] = [None]
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
        usage_out=usage_holder,
    ):
        parts.append(delta)
    return LlmCompletionResult(
        text="".join(parts).strip(),
        openai_response_id=holder[0] if holder else None,
        usage=usage_holder[0] if usage_holder else None,
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
        provider_kind=provider_connection.provider_kind,
    )

    def _run() -> dict[str, str]:
        base = _provider_base_url(provider_connection)
        provider_kind = (provider_connection.provider_kind or "").strip().lower()
        if provider_kind == "anthropic":
            output = _anthropic_messages_result(
                provider_connection,
                prompt=prompt,
                model_id=resolved_model,
                system_prompt="You are a helpful assistant.",
                temperature=0,
                max_tokens=256,
            ).text
            return {
                "api_mode": api_mode,
                "model": resolved_model,
                "base_url": _anthropic_base_url(provider_connection),
                "output": output.strip(),
            }
        if provider_kind == "google_gemini" and _is_gemini_native_base_url(base):
            output = _gemini_generate_content(provider_connection, prompt=prompt, model_id=resolved_model)
            return {
                "api_mode": api_mode,
                "model": resolved_model,
                "base_url": base,
                "output": output.strip(),
            }
        if _use_openai_responses_sdk(
            provider_connection,
            api_mode=api_mode,
            use_openai_responses_http=False,
        ):
            client = _build_openai_compatible_client(provider_connection)
            response = client.responses.create(
                model=resolved_model,
                instructions="You are a helpful assistant.",
                input=prompt,
                temperature=0,
                stream=False,
            )
            output = (getattr(response, "output_text", None) or "").strip()
        else:
            client = _build_openai_compatible_client(provider_connection)
            response = client.chat.completions.create(
                model=resolved_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                stream=False,
            )
            if isinstance(response, str):
                output = response.strip()
            else:
                output = (response.choices[0].message.content if response.choices else "") or ""
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
