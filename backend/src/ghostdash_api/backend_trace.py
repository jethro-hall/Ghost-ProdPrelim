from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .public_response_presenter import is_production_chat_surface


def format_backend_exception(exc: BaseException | None) -> str:
    if exc is None:
        return ""
    response = getattr(exc, "response", None)
    status_code = getattr(exc, "status_code", None)
    if status_code is None and response is not None:
        status_code = getattr(response, "status_code", None)
    body = ""
    if response is not None:
        try:
            if hasattr(response, "json"):
                payload = response.json()
                if isinstance(payload, (dict, list)):
                    body = str(payload)
                else:
                    body = str(payload)
            elif hasattr(response, "text"):
                body = str(response.text or "")
        except Exception:
            body = ""
    if body.strip():
        prefix = f"{type(exc).__name__}"
        if status_code is not None:
            prefix = f"{prefix}(status={status_code})"
        return f"{prefix}: {body.strip()[:4000]}"
    return repr(exc)


def append_backend_trace(
    route_decision: dict[str, Any],
    *,
    kind: str,
    level: str,
    message: str,
    detail: Any = None,
) -> None:
    entry: dict[str, Any] = {
        "at": datetime.now(UTC).isoformat(),
        "kind": kind,
        "level": level,
        "message": message,
    }
    if detail is not None:
        entry["detail"] = detail
    route_decision.setdefault("backend_trace", []).append(entry)


def mark_generation_path(route_decision: dict[str, Any], path: str) -> None:
    route_decision["generation_path"] = path


def should_expose_raw_backend_errors(surface: str | None) -> bool:
    return not is_production_chat_surface(surface)
