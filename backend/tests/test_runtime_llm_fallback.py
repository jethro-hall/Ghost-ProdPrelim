from __future__ import annotations

from ghostdash_api import runtime
from ghostdash_api.runtime import _normalize_provider_model_id, _responses_error_should_fallback_to_chat


def test_responses_fallback_activates_on_504_upstream_timeout() -> None:
    exc = RuntimeError("Error code: 504 - {'detail': 'upstream llm timeout'}")
    assert _responses_error_should_fallback_to_chat(exc) is True


def test_responses_fallback_on_read_timeout() -> None:
    assert _responses_error_should_fallback_to_chat(TimeoutError("read timed out")) is True


def test_responses_fallback_false_on_benign() -> None:
    assert _responses_error_should_fallback_to_chat(ValueError("invalid json")) is False


def test_openai_compatible_provider_kind_strips_openai_prefix() -> None:
    assert (
        _normalize_provider_model_id(
            "lg-llm-gp",
            "openai/gpt-4-turbo",
            "openai/llama31-8b",
            provider_kind="openai",
        )
        == "gpt-4-turbo"
    )


def test_openai_compatible_responses_endpoint_uses_chat_completions() -> None:
    connection = runtime.ProviderConnectionConfig(
        provider="openai",
        label="RE-JH-LLM05",
        provider_kind="openai_compatible",
        auth_strategy="bearer",
        api_key="test-key",
        base_url="https://one.rideai.com.au/v1/responses",
    )
    assert runtime._requires_openai_sdk_client(connection) is True
    assert runtime._use_openai_responses_sdk(connection, api_mode="responses", use_openai_responses_http=False) is False
    assert runtime._provider_base_url(connection) == "https://one.rideai.com.au/v1"


def test_openai_compatible_preserves_custom_gateway_model_case() -> None:
    assert (
        _normalize_provider_model_id(
            "openai",
            "RE-JH-LLM05",
            "openai/llama31-8b",
            provider_kind="openai_compatible",
        )
        == "RE-JH-LLM05"
    )


def test_rideai_root_base_url_normalizes_to_v1() -> None:
    connection = runtime.ProviderConnectionConfig(
        provider="openai",
        label="RE-JH-LLM05",
        provider_kind="openai_compatible",
        auth_strategy="custom_header",
        auth_header_name="X-Internal-Key",
        api_key="test-key",
        base_url="https://one.rideai.com.au/",
    )
    assert runtime._provider_base_url(connection) == "https://one.rideai.com.au/v1"
    assert runtime._uses_rideai_chat_gateway(connection) is True
