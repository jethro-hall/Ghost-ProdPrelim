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
