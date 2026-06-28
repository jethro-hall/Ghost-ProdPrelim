"""
External Data API client.

Server-side wrapper around the FDL analytics gateway exposed at
EXTERNAL_DATA_API_URL (default http://3.105.115.144:4110/api/v1). The API key
lives in EXTERNAL_DATA_API_KEY and is injected server-side; the browser and
the LLM never see it.

Surface:
    list_snapshots()                       GET    /api/v1/snapshots
    run_query(snapshot_id, sql)            POST   /api/v1/snapshots/:id/query
    search(snapshot_id, query, model?)     POST   /api/v1/snapshots/:id/search
    get_metrics(snapshot_id)               GET    /api/v1/snapshots/:id/metrics
    cross_query(snapshot_ids, sql)         POST   /api/v1/query

Only SELECT statements are accepted by the upstream API; this client refuses
anything else before it crosses the network so we never touch
finance data with a write attempt by mistake.
"""
from __future__ import annotations

import logging
import re
import time
import urllib.parse
from typing import Any

import httpx

from .config import get_settings
from .observability import log_event, new_span_id

logger = logging.getLogger(__name__)

_settings = get_settings()


class ExternalDataAPIError(RuntimeError):
    """Raised on non-2xx upstream responses or transport errors."""

    def __init__(self, message: str, *, status_code: int | None = None, payload: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


_SELECT_ONLY_RE = re.compile(r"^\s*(?:--[^\n]*\n|/\*.*?\*/\s*)*\s*(WITH|SELECT)\b", re.IGNORECASE | re.DOTALL)


def _ensure_select_only(sql: str) -> str:
    stripped = (sql or "").strip()
    if not stripped:
        raise ExternalDataAPIError("sql is required", status_code=400)
    if not _SELECT_ONLY_RE.match(stripped):
        raise ExternalDataAPIError(
            "Only SELECT (or WITH ... SELECT) statements are allowed.",
            status_code=400,
        )
    return stripped


def _client() -> httpx.Client:
    base = _settings.external_data_api_url.rstrip("/")
    headers: dict[str, str] = {"Accept": "application/json"}
    if _settings.external_data_api_key:
        headers["X-RideAI-API-Key"] = _settings.external_data_api_key
    return httpx.Client(
        base_url=base,
        timeout=_settings.external_data_api_timeout_seconds,
        headers=headers,
    )


def _outbound(route: str, start: float, status: str | int, error: str | None, trace_id: str) -> None:
    log_event(
        trace_id=trace_id,
        span_id=new_span_id(),
        service="agent-runtime",
        route=f"external-data/{route}",
        start_ts=start,
        end_ts=time.time(),
        status=status,
        error=error,
    )


def _request(method: str, path: str, *, json_body: dict | None = None, trace_id: str = "untraced") -> Any:
    if not _settings.external_data_api_key:
        raise ExternalDataAPIError(
            "EXTERNAL_DATA_API_KEY is not configured on the agent-runtime service.",
            status_code=500,
        )
    start = time.time()
    try:
        with _client() as client:
            resp = client.request(method, path, json=json_body)
    except httpx.TimeoutException as exc:
        _outbound(path, start, "timeout", str(exc), trace_id)
        raise ExternalDataAPIError(f"External Data API timed out: {exc}", status_code=504) from exc
    except httpx.HTTPError as exc:
        _outbound(path, start, "transport_error", str(exc), trace_id)
        raise ExternalDataAPIError(f"External Data API transport error: {exc}", status_code=502) from exc

    if resp.status_code >= 400:
        body_preview = resp.text[:500]
        try:
            payload = resp.json()
        except Exception:
            payload = {"body": body_preview}
        _outbound(path, start, resp.status_code, body_preview, trace_id)
        # Never include any header (and therefore never the api key) in error message.
        message = (
            (payload.get("message") if isinstance(payload, dict) else None)
            or (payload.get("error") if isinstance(payload, dict) else None)
            or f"External Data API returned HTTP {resp.status_code}"
        )
        raise ExternalDataAPIError(str(message), status_code=resp.status_code, payload=payload)

    _outbound(path, start, resp.status_code, None, trace_id)
    try:
        return resp.json()
    except Exception as exc:
        raise ExternalDataAPIError(f"External Data API returned non-JSON body: {exc}", status_code=502) from exc


def _enc(snapshot_id: str) -> str:
    return urllib.parse.quote(snapshot_id, safe="")


def list_snapshots(*, trace_id: str = "untraced") -> dict[str, Any]:
    return _request("GET", "/api/v1/snapshots", trace_id=trace_id)


def run_query(
    snapshot_id: str,
    sql: str,
    *,
    trace_id: str = "untraced",
) -> dict[str, Any]:
    sql = _ensure_select_only(sql)
    payload = _request(
        "POST",
        f"/api/v1/snapshots/{_enc(snapshot_id)}/query",
        json_body={"sql": sql},
        trace_id=trace_id,
    )
    return _truncate_rows(payload)


def search(
    snapshot_id: str,
    query: str,
    *,
    model: str | None = None,
    trace_id: str = "untraced",
) -> dict[str, Any]:
    body: dict[str, Any] = {"query": query}
    if model:
        body["model"] = model
    return _request(
        "POST",
        f"/api/v1/snapshots/{_enc(snapshot_id)}/search",
        json_body=body,
        trace_id=trace_id,
    )


def get_metrics(snapshot_id: str, *, trace_id: str = "untraced") -> dict[str, Any]:
    return _request(
        "GET",
        f"/api/v1/snapshots/{_enc(snapshot_id)}/metrics",
        trace_id=trace_id,
    )


def cross_query(
    snapshot_ids: list[str],
    sql: str,
    *,
    trace_id: str = "untraced",
) -> dict[str, Any]:
    sql = _ensure_select_only(sql)
    if not snapshot_ids:
        raise ExternalDataAPIError("snapshot_ids is required", status_code=400)
    payload = _request(
        "POST",
        "/api/v1/query",
        json_body={"snapshot_ids": snapshot_ids, "sql": sql},
        trace_id=trace_id,
    )
    return _truncate_rows(payload)


def _truncate_rows(payload: dict[str, Any]) -> dict[str, Any]:
    """Cap result rows to EXTERNAL_DATA_API_MAX_ROWS so we never blow up
    the agent-runtime container memory if a query forgets a LIMIT."""
    rows = payload.get("rows") if isinstance(payload, dict) else None
    if isinstance(rows, list):
        cap = _settings.external_data_api_max_rows
        if len(rows) > cap:
            payload = dict(payload)
            payload["rows"] = rows[:cap]
            payload["truncated"] = True
            payload["truncated_to"] = cap
            payload["original_row_count"] = len(rows)
    return payload
