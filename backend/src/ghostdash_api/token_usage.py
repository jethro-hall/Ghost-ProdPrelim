"""Approximate LLM token counts for chat cost visibility (cl100k; not provider billing)."""

from __future__ import annotations

import tiktoken

_ENCODER = tiktoken.get_encoding("cl100k_base")


def estimate_token_count(text: str) -> int:
    if not text or not str(text).strip():
        return 0
    return len(_ENCODER.encode(str(text)))


def estimate_llm_turn_usage_dict(
    *,
    system_prompt: str,
    user_prompt: str | None,
    completion: str,
    fallback_user_prompt: str = "",
    skip_llm: bool = False,
) -> dict[str, int | bool]:
    """Tokens for one assistant turn: system + user bundle (single user message) + completion."""
    if skip_llm:
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "estimate": True}
    user = (user_prompt if user_prompt is not None else fallback_user_prompt) or ""
    prompt_tokens = estimate_token_count(system_prompt) + estimate_token_count(user)
    completion_tokens = estimate_token_count(completion)
    total = prompt_tokens + completion_tokens
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total,
        "estimate": True,
    }


def normalize_provider_usage_dict(
    *,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    total_tokens: int | None,
) -> dict[str, int | bool] | None:
    if prompt_tokens is None and completion_tokens is None and total_tokens is None:
        return None
    resolved_prompt = int(prompt_tokens or 0)
    resolved_completion = int(completion_tokens or 0)
    resolved_total = int(total_tokens) if total_tokens is not None else resolved_prompt + resolved_completion
    return {
        "prompt_tokens": resolved_prompt,
        "completion_tokens": resolved_completion,
        "total_tokens": resolved_total,
        "estimate": False,
    }


def resolve_chat_usage_dict(
    *,
    provider_usage: dict[str, int | bool] | None,
    system_prompt: str,
    user_prompt: str | None,
    completion: str,
    fallback_user_prompt: str = "",
    skip_llm: bool = False,
) -> dict[str, int | bool]:
    if provider_usage is not None:
        return {
            "prompt_tokens": int(provider_usage.get("prompt_tokens") or 0),
            "completion_tokens": int(provider_usage.get("completion_tokens") or 0),
            "total_tokens": int(provider_usage.get("total_tokens") or 0),
            "estimate": bool(provider_usage.get("estimate", False)),
        }
    return estimate_llm_turn_usage_dict(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        completion=completion,
        fallback_user_prompt=fallback_user_prompt,
        skip_llm=skip_llm,
    )
