"""Tests for OpenAI / LlamaIndex configuration helpers (no live API calls)."""

import os

import pytest

from rag.workflow import (
    _default_embedding_model,
    _default_llm_model,
    ensure_openai_settings,
)


def test_default_llm_model_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    assert _default_llm_model() == "gpt-5.4"
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    assert _default_llm_model() == "gpt-4o-mini"


def test_default_embedding_model_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_EMBEDDING_MODEL", raising=False)
    assert _default_embedding_model() == "text-embedding-3-small"
    monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-large")
    assert _default_embedding_model() == "text-embedding-3-large"


def test_ensure_openai_settings_requires_no_api_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """Constructs OpenAI clients from env; does not call the network."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-dummy-key-for-unit-test")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4o-mini")
    monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
    ensure_openai_settings()
    from llama_index.core import Settings

    assert Settings.llm is not None
    assert Settings.embed_model is not None
