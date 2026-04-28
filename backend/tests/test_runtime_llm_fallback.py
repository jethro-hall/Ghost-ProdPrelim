from __future__ import annotations

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
