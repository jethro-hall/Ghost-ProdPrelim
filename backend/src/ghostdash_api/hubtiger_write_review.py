"""Filesystem queue for HubTiger write operations pending staff review."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .settings import get_settings

logger = logging.getLogger(__name__)

HUBTIGER_WRITE_REVIEW_STATUS_PENDING = "pending_staff_review"
HUBTIGER_WRITE_REVIEW_STATUS_APPROVED = "approved_pending_replay"
HUBTIGER_WRITE_REVIEW_STATUS_REJECTED = "rejected"
HUBTIGER_WRITE_REVIEW_STATUS_EXECUTED = "executed"


def _queue_dirs() -> tuple[Path, Path]:
    settings = get_settings()
    preferred = settings.data_dir / "hubtiger" / "write-review-queue"
    fallback = Path("/tmp/ghostdash/hubtiger/write-review-queue")
    return preferred, fallback


def _resolve_queue_dir() -> Path:
    preferred, fallback = _queue_dirs()
    try:
        preferred.mkdir(parents=True, exist_ok=True)
        return preferred
    except OSError:
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def pending_queue_path() -> Path:
    return _resolve_queue_dir() / "pending.ndjson"


def status_log_path() -> Path:
    return _resolve_queue_dir() / "reviews.log"


def _read_ndjson(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw:
            continue
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            rows.append(item)
    return rows


def _append_line(path: Path, entry: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fp:
        fp.write(json.dumps(entry, ensure_ascii=True) + "\n")


def _log_review_event(
    *,
    trace_id: str,
    route: str,
    review_id: str,
    operation: str,
    status: str,
    latency_ms: int,
    error: str | None = None,
) -> None:
    payload = {
        "trace_id": trace_id,
        "span_id": trace_id[:16],
        "service": "control-api",
        "route": route,
        "start_ts": datetime.now(timezone.utc).isoformat(),
        "end_ts": datetime.now(timezone.utc).isoformat(),
        "latency_ms": latency_ms,
        "status": status,
        "error": error,
        "review_id": review_id,
        "operation": operation,
    }
    logger.info(json.dumps(payload, ensure_ascii=True))


def append_pending_review(entry: dict[str, Any]) -> Path:
    path = pending_queue_path()
    _append_line(path, entry)
    return path


def append_status_event(
    *,
    review_id: str,
    status: str,
    trace_id: str,
    operation: str,
    reason: str | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    event = {
        "review_id": review_id,
        "status": status,
        "trace_id": trace_id,
        "operation": operation,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if reason:
        event["reason"] = reason
    if extra:
        event["extra"] = extra
    _append_line(status_log_path(), event)


def list_pending_reviews(*, limit: int = 50) -> list[dict[str, Any]]:
    rows = _read_ndjson(pending_queue_path())
    statuses = _review_status_index()
    pending: list[dict[str, Any]] = []
    for row in reversed(rows):
        review_id = str(row.get("review_id") or "").strip()
        if not review_id:
            continue
        current = statuses.get(review_id, HUBTIGER_WRITE_REVIEW_STATUS_PENDING)
        if current != HUBTIGER_WRITE_REVIEW_STATUS_PENDING:
            continue
        pending.append(_public_review_view(row, current_status=current))
        if len(pending) >= limit:
            break
    return pending


def _review_status_index() -> dict[str, str]:
    index: dict[str, str] = {}
    for event in _read_ndjson(status_log_path()):
        review_id = str(event.get("review_id") or "").strip()
        status = str(event.get("status") or "").strip()
        if review_id and status:
            index[review_id] = status
    return index


def get_review_entry(review_id: str) -> dict[str, Any] | None:
    target = str(review_id or "").strip()
    if not target:
        return None
    statuses = _review_status_index()
    for row in reversed(_read_ndjson(pending_queue_path())):
        if str(row.get("review_id") or "").strip() == target:
            status = statuses.get(target, HUBTIGER_WRITE_REVIEW_STATUS_PENDING)
            return _operator_review_view(row, current_status=status)
    return None


def _public_review_view(row: dict[str, Any], *, current_status: str) -> dict[str, Any]:
    return {
        "review_id": row.get("review_id"),
        "created_at": row.get("created_at"),
        "operation": row.get("operation"),
        "review_status": current_status,
        "store": (row.get("payload") or {}).get("store") if isinstance(row.get("payload"), dict) else None,
        "preflight_passed_at": row.get("preflight_passed_at"),
    }


def _operator_review_view(row: dict[str, Any], *, current_status: str) -> dict[str, Any]:
    view = dict(row)
    view["review_status"] = current_status
    return view
