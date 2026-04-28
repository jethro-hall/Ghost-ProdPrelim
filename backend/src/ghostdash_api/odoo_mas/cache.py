from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta


_CACHE: dict[str, tuple[datetime, dict]] = {}


def build_cache_key(payload: dict) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def get_cached_value(key: str, *, ttl_seconds: int = 600) -> dict | None:
    row = _CACHE.get(key)
    if row is None:
        return None
    created_at, value = row
    if datetime.now(UTC) - created_at > timedelta(seconds=ttl_seconds):
        _CACHE.pop(key, None)
        return None
    return value


def set_cached_value(key: str, value: dict) -> None:
    _CACHE[key] = (datetime.now(UTC), value)
