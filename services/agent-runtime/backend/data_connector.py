"""
Data connector — generic catalog / schema / query / materialize.

Wraps:
  - rapids-analytics:8010  (GPU cuDF mirror)
  - Odoo JSON-RPC          (live ERP data — session-auth pattern)

Exposed as generic tool implementations.
NO domain-specific finance functions.

Odoo availability:
  On any 404 or auth error the tool returns a graceful observation directing
  the model to use the gpu source instead. The model should never see a raw
  HTTP error code — it gets a clear actionable message.
"""
from __future__ import annotations

import hashlib
import json
import logging
import pathlib
import time
import uuid
from typing import Any

import httpx

from .config import get_settings
from .observability import log_event, new_span_id
from .sandbox_runner import sandbox_root
from .tool_registry import ToolResult, _wrap_observation

logger = logging.getLogger(__name__)
_settings = get_settings()

# ── Module-level Odoo session cache ──────────────────────────────────────────
# The session cookie is reused across calls within the same process lifetime.
# On auth failure the cached session is cleared and re-authenticated on next call.
_odoo_session: httpx.Client | None = None
_odoo_session_uid: int | None = None


# ── Observability helper ──────────────────────────────────────────────────────

def _outbound_log(
    route: str,
    start: float,
    status: str | int,
    error: str | None = None,
    trace_id: str = "untraced",
) -> None:
    log_event(
        trace_id=trace_id,
        span_id=new_span_id(),
        service="agent-runtime",
        route=route,
        start_ts=start,
        end_ts=time.time(),
        status=status,
        error=error,
    )


# ── Odoo JSON-RPC client ──────────────────────────────────────────────────────

def _odoo_client() -> httpx.Client:
    """Return a persistent httpx client with session cookies."""
    global _odoo_session
    if _odoo_session is None:
        _odoo_session = httpx.Client(
            base_url=_settings.odoo_url.rstrip("/"),
            timeout=30.0,
            follow_redirects=True,
        )
    return _odoo_session


def _odoo_authenticate() -> int:
    """
    Authenticate against Odoo and return the session uid.
    Uses /web/session/authenticate (works on Odoo 14+).
    Clears and recreates the session client on each call.
    """
    global _odoo_session, _odoo_session_uid
    _odoo_session = None  # reset cookies
    client = _odoo_client()

    payload = {
        "jsonrpc": "2.0",
        "method": "call",
        "id": 1,
        "params": {
            "db": _settings.odoo_db,
            "login": _settings.odoo_user,
            "password": _settings.odoo_password,
        },
    }
    t0 = time.time()
    try:
        resp = client.post("/web/session/authenticate", json=payload)
        resp.raise_for_status()
        data = resp.json()
        result = data.get("result", {})
        uid = result.get("uid")
        if not uid:
            raise RuntimeError("Authentication returned no uid — check ODOO_DB/USER/PASSWORD.")
        _odoo_session_uid = uid
        _outbound_log("odoo/session/authenticate", t0, "ok")
        return uid
    except Exception as exc:
        _outbound_log("odoo/session/authenticate", t0, "error", str(exc))
        raise


def _odoo_call_kw(
    model: str,
    method: str,
    args: list[Any],
    kwargs: dict[str, Any],
    trace_id: str = "untraced",
    *,
    retry_auth: bool = True,
) -> Any:
    """
    Call an Odoo model method via /web/dataset/call_kw.
    Authenticates lazily; retries once on 401/session-expired.
    Raises RuntimeError on persistent failure.
    """
    global _odoo_session_uid
    if _odoo_session_uid is None:
        _odoo_authenticate()

    client = _odoo_client()
    payload = {
        "jsonrpc": "2.0",
        "method": "call",
        "id": 1,
        "params": {
            "model": model,
            "method": method,
            "args": args,
            "kwargs": kwargs,
        },
    }
    t0 = time.time()
    route = f"odoo/{model}/{method}"
    try:
        resp = client.post("/web/dataset/call_kw", json=payload)
    except Exception as exc:
        _outbound_log(route, t0, "error", str(exc), trace_id)
        raise

    if resp.status_code in (401, 403) or resp.status_code == 404:
        _outbound_log(route, t0, resp.status_code, f"HTTP {resp.status_code}", trace_id)
        if retry_auth:
            # Re-authenticate once and retry
            try:
                _odoo_authenticate()
            except Exception as auth_exc:
                raise RuntimeError(f"Odoo re-auth failed: {auth_exc}") from auth_exc
            return _odoo_call_kw(model, method, args, kwargs, trace_id, retry_auth=False)
        raise RuntimeError(f"Odoo {route} returned HTTP {resp.status_code} after re-auth.")

    resp.raise_for_status()
    data = resp.json()
    if data.get("error"):
        err = data["error"]
        msg = err.get("data", {}).get("message") or str(err)
        _outbound_log(route, t0, "rpc_error", msg, trace_id)
        raise RuntimeError(f"Odoo RPC error on {route}: {msg}")

    _outbound_log(route, t0, "ok", trace_id=trace_id)
    return data.get("result")


def _odoo_unavailable_result(call_id: str, detail: str) -> ToolResult:
    """Return a graceful observation when Odoo is unreachable or failing."""
    msg = (
        f"Odoo data source is currently unavailable: {detail}\n"
        "Use source='gpu' with the rapids-analytics mirror instead. "
        "The GPU mirror contains the same accounting data and supports cuDF analytics."
    )
    return ToolResult(
        call_id=call_id,
        tool_name="odoo",
        status="failed",
        observation_for_model=_wrap_observation("data_connector.odoo", call_id, msg),
    )


# ── catalog_data_sources ──────────────────────────────────────────────────────

def catalog_data_sources(
    args: dict[str, Any],
    run_id: str,
    call_id: str,
    trace_id: str = "untraced",
) -> ToolResult:
    """List available data sources. No rows returned — metadata only."""
    filter_kw = str(args.get("filter") or "").lower()
    catalog: dict[str, Any] = {"sources": []}

    # GPU mirror
    t0 = time.time()
    try:
        resp = httpx.get(f"{_settings.rapids_url}/catalog", timeout=10)
        if resp.status_code == 200:
            gpu_cat = resp.json()
            frames = gpu_cat.get("frames", {})
            gpu_frames = []
            for frame_id, info in frames.items():
                if filter_kw and filter_kw not in frame_id.lower():
                    continue
                gpu_frames.append(
                    {
                        "id": frame_id,
                        "rows": info.get("rows", 0),
                        "columns": list(info.get("columns", {}).keys()),
                        "column_count": len(info.get("columns", {})),
                    }
                )
            catalog["sources"].append(
                {
                    "source": "gpu",
                    "description": "GPU-accelerated cuDF mirror of Odoo data (nightly sync)",
                    "engine": "cudf",
                    "gpu_total_mb": gpu_cat.get("gpu_total_mb"),
                    "gpu_used_mb": gpu_cat.get("gpu_used_mb"),
                    "frame_count": len(gpu_frames),
                    "frames": gpu_frames,
                    "HOW_TO_QUERY": (
                        "Use execute_python to run cuDF analytics directly via the GPU service. "
                        "Example code:\n"
                        "  import httpx, json\n"
                        "  resp = httpx.post('http://rapids-analytics:8010/execute', "
                        "json={'script': 'df = gf(\"FRAME_NAME\")\\nresult = float(df[\"debit\"].sum())'}, timeout=60)\n"
                        "  data = resp.json()\n"
                        "  result = data['result']  # your computed value\n"
                        "Replace FRAME_NAME with e.g. 'c3_fy2025_account_move_line'. "
                        "gf() loads the named GPU frame. result= sets the return value. "
                        "Use .groupby().agg() for aggregations. "
                        "Avoid to_pandas() for large frames — work in cuDF then only call to_pandas() on small results."
                    ),
                }
            )
            _outbound_log("rapids/catalog", t0, "ok", trace_id=trace_id)
        else:
            catalog["gpu_error"] = f"HTTP {resp.status_code}"
            _outbound_log("rapids/catalog", t0, resp.status_code, trace_id=trace_id)
    except Exception as exc:
        catalog["gpu_error"] = str(exc)
        _outbound_log("rapids/catalog", t0, "error", str(exc), trace_id)

    # Odoo live
    if _settings.odoo_url:
        try:
            models_raw = _odoo_call_kw(
                "ir.model", "search_read",
                args=[[]],
                kwargs={"fields": ["model", "name"], "limit": 200, "order": "model asc"},
                trace_id=trace_id,
            )
            odoo_models = [
                {"model": m["model"], "name": m["name"]}
                for m in (models_raw or [])
                if not filter_kw or filter_kw in m["model"].lower()
            ]
            catalog["sources"].append(
                {
                    "source": "odoo",
                    "description": "Live Odoo ERP data via JSON-RPC (read-only)",
                    "model_count": len(odoo_models),
                    "models": odoo_models[:50],
                    "note": "Use inspect_schema to see fields. Use query_data to fetch rows.",
                }
            )
        except Exception as exc:
            catalog["odoo_error"] = f"Odoo unavailable: {exc}. Use gpu source instead."

    summary = json.dumps(catalog, indent=2, default=str)
    return ToolResult(
        call_id=call_id,
        tool_name="catalog_data_sources",
        status="completed",
        observation_for_model=_wrap_observation("catalog_data_sources", call_id, summary),
        raw_output=catalog,
    )


# ── inspect_schema ────────────────────────────────────────────────────────────

def inspect_schema(
    args: dict[str, Any],
    run_id: str,
    call_id: str,
    trace_id: str = "untraced",
) -> ToolResult:
    source = str(args.get("source", "gpu")).strip().lower()
    table = str(args.get("table", "")).strip()

    if source == "gpu":
        return _inspect_schema_gpu(table, call_id, trace_id)
    elif source == "odoo":
        return _inspect_schema_odoo(table, call_id, trace_id)
    else:
        return ToolResult(
            call_id=call_id,
            tool_name="inspect_schema",
            status="failed",
            observation_for_model=_wrap_observation(
                "inspect_schema", call_id, f"Unknown source: '{source}'. Use 'gpu' or 'odoo'."
            ),
        )


def _inspect_schema_gpu(table: str, call_id: str, trace_id: str) -> ToolResult:
    t0 = time.time()
    try:
        resp = httpx.get(f"{_settings.rapids_url}/catalog", timeout=5)
        _outbound_log("rapids/catalog", t0, resp.status_code, trace_id=trace_id)
        cat = resp.json()
        frames = cat.get("frames", {})
        if table not in frames:
            available = ", ".join(sorted(frames.keys())[:20])
            return ToolResult(
                call_id=call_id,
                tool_name="inspect_schema",
                status="failed",
                observation_for_model=_wrap_observation(
                    "inspect_schema", call_id,
                    f"Frame '{table}' not found in GPU catalog.\nAvailable (first 20): {available}"
                ),
            )
        frame_info = frames[table]
        row_count = frame_info.get("rows", 0)
        columns = frame_info.get("columns", {})

        sample = []
        try:
            t1 = time.time()
            exec_resp = httpx.post(
                f"{_settings.rapids_url}/execute",
                json={
                    "script": (
                        f"df = gf('{table}')\n"
                        "import json\n"
                        "sample = df.head(3).to_pandas().to_dict(orient='records')\n"
                        "result = sample\n"
                    )
                },
                timeout=8,  # Non-critical sample — skip if GPU is slow
            )
            _outbound_log("rapids/execute", t1, exec_resp.status_code, trace_id=trace_id)
            if exec_resp.status_code == 200:
                data = exec_resp.json()
                if data.get("ok"):
                    sample = data.get("result", [])
        except Exception:
            pass

        schema_info = {
            "source": "gpu",
            "frame": table,
            "row_count": row_count,
            "columns": columns,
            "sample_rows": sample,
        }
        return ToolResult(
            call_id=call_id,
            tool_name="inspect_schema",
            status="completed",
            observation_for_model=_wrap_observation(
                "inspect_schema", call_id, json.dumps(schema_info, indent=2, default=str)
            ),
            raw_output=schema_info,
        )
    except Exception as exc:
        _outbound_log("rapids/catalog", t0, "error", str(exc), trace_id)
        return ToolResult(
            call_id=call_id,
            tool_name="inspect_schema",
            status="failed",
            observation_for_model=_wrap_observation("inspect_schema", call_id, str(exc)),
        )


def _inspect_schema_odoo(model: str, call_id: str, trace_id: str) -> ToolResult:
    try:
        fields_raw = _odoo_call_kw(
            model, "fields_get",
            args=[], kwargs={"attributes": ["string", "type", "required"]},
            trace_id=trace_id,
        )
        sample_raw = _odoo_call_kw(
            model, "search_read",
            args=[[]],
            kwargs={"fields": list(fields_raw.keys())[:20] if fields_raw else [], "limit": 3},
            trace_id=trace_id,
        )
        count_raw = _odoo_call_kw(
            model, "search_count",
            args=[[]], kwargs={},
            trace_id=trace_id,
        )
        schema_info = {
            "source": "odoo",
            "model": model,
            "row_count": count_raw,
            "fields": fields_raw,
            "sample_rows": sample_raw,
        }
        return ToolResult(
            call_id=call_id,
            tool_name="inspect_schema",
            status="completed",
            observation_for_model=_wrap_observation(
                "inspect_schema", call_id, json.dumps(schema_info, indent=2, default=str)
            ),
            raw_output=schema_info,
        )
    except Exception as exc:
        return _odoo_unavailable_result(call_id, str(exc))


# ── query_data ────────────────────────────────────────────────────────────────

def query_data(
    args: dict[str, Any],
    run_id: str,
    call_id: str,
    trace_id: str = "untraced",
) -> ToolResult:
    source = str(args.get("source", "gpu")).strip().lower()
    table = str(args.get("table", "")).strip()
    fields = args.get("fields") or []
    filters = args.get("filters") or {}
    domain = args.get("domain") or []
    limit = min(int(args.get("limit") or 1000), 1000)
    full_export = bool(args.get("full_export", False))
    artifact_name = str(args.get("artifact_name") or f"{table}.parquet").strip()

    if full_export:
        if source == "gpu":
            hint = (
                f"For large GPU frame exports, use execute_python instead of full_export=true.\n"
                f"Example:\n"
                f"  import httpx, json\n"
                f"  resp = httpx.post('http://rapids-analytics:8010/execute', json={{'script':\n"
                f"    'import json\\n"
                f"df = gf(\"{table}\")\\n"
                f"result = df.groupby(\"account_id_name\")[\"credit\"].sum().to_pandas().sort_values(ascending=False).head(10).to_dict()'\n"
                f"  }}, timeout=60)\n"
                f"  data = resp.json()\n"
                f"  result = data['result']"
            )
            return ToolResult(
                call_id=call_id,
                tool_name="query_data",
                status="failed",
                observation_for_model=_wrap_observation("query_data", call_id, hint),
            )
        return _materialize_parquet(
            source=source,
            table=table,
            fields=fields,
            domain=domain,
            artifact_name=artifact_name,
            run_id=run_id,
            call_id=call_id,
            trace_id=trace_id,
        )

    if source == "gpu":
        return _query_gpu(table, fields, filters, limit, call_id, trace_id)
    elif source == "odoo":
        return _query_odoo(table, fields, domain, limit, call_id, trace_id)
    else:
        return ToolResult(
            call_id=call_id,
            tool_name="query_data",
            status="failed",
            observation_for_model=_wrap_observation(
                "query_data", call_id, f"Unknown source: '{source}'."
            ),
        )


def _query_gpu(
    table: str,
    fields: list[str],
    filters: dict[str, Any],
    limit: int,
    call_id: str,
    trace_id: str,
) -> ToolResult:
    field_list = fields if fields else None
    filter_parts = []
    for k, v in filters.items():
        if isinstance(v, str):
            filter_parts.append(f'df[df["{k}"] == "{v}"]')
        else:
            filter_parts.append(f'df[df["{k}"] == {v}]')

    filter_line = ""
    if filter_parts:
        filter_line = "df = " + ".".join(filter_parts) + "\n"

    cols_line = ""
    if field_list:
        cols_line = f"cols = [c for c in {field_list!r} if c in df.columns]\ndf = df[cols]\n"

    script = (
        f"import json\n"
        f"df = gf('{table}')\n"
        f"{filter_line}"
        f"{cols_line}"
        f"df = df.head({limit})\n"
        f"result = df.to_pandas().to_dict(orient='records')\n"
    )

    # Fail fast — if GPU is unhealthy, tell Claude to use execute_python instead
    t0 = time.time()
    try:
        resp = httpx.post(
            f"{_settings.rapids_url}/execute",
            json={"script": script},
            timeout=15,  # Fast fail — GPU should respond in <5s when healthy
        )
        _outbound_log("rapids/execute", t0, resp.status_code, trace_id=trace_id)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("ok"):
                rows = data.get("result", [])
                summary = (
                    f"{len(rows)} rows returned from GPU frame '{table}'.\n"
                    f"Fields: {', '.join(str(k) for k in rows[0].keys()) if rows else 'none'}"
                )
                return ToolResult(
                    call_id=call_id,
                    tool_name="query_data",
                    status="completed",
                    observation_for_model=_wrap_observation(
                        "query_data", call_id,
                        summary + "\n\n" + json.dumps(rows[:100], indent=2, default=str)
                        + (f"\n\n[{len(rows)-100} more rows omitted]" if len(rows) > 100 else ""),
                    ),
                    raw_output=rows,
                )
            else:
                error = data.get("error", "GPU execute returned ok=false")
    except Exception as exc:
        error = str(exc)

    _outbound_log("rapids/execute", t0, "error", error[:100], trace_id)
    redirect = (
        f"GPU query failed: {error[:200]}\n\n"
        f"Use execute_python to query directly:\n"
        f"  import httpx, os\n"
        f"  url = os.environ.get('RAPIDS_URL', 'http://rapids-analytics:8010')\n"
        f"  r = httpx.post(url + '/execute', json={{'script':\n"
        f"    'df = gf(\"{table}\")\\n"
        f"result = {{\\\"rows\\\": len(df), \\\"debit\\\": float(df[\\\"debit\\\"].sum())}}'\n"
        f"  }}, timeout=60)\n"
        f"  print(r.json()['result'])"
    )
    return ToolResult(
        call_id=call_id,
        tool_name="query_data",
        status="failed",
        observation_for_model=_wrap_observation("query_data", call_id, redirect),
    )

    return ToolResult(
        call_id=call_id,
        tool_name="query_data",
        status="failed",
        observation_for_model=_wrap_observation("query_data", call_id, "GPU query failed after all retries."),
    )


def _query_odoo(
    model: str,
    fields: list[str],
    domain: list[Any],
    limit: int,
    call_id: str,
    trace_id: str,
) -> ToolResult:
    try:
        rows = _odoo_call_kw(
            model, "search_read",
            args=[domain or []],
            kwargs={"fields": fields or [], "limit": limit},
            trace_id=trace_id,
        )
        summary = f"{len(rows or [])} rows from Odoo model '{model}'."
        return ToolResult(
            call_id=call_id,
            tool_name="query_data",
            status="completed",
            observation_for_model=_wrap_observation(
                "query_data", call_id,
                summary + "\n\n" + json.dumps((rows or [])[:50], indent=2, default=str),
            ),
            raw_output=rows,
        )
    except Exception as exc:
        return _odoo_unavailable_result(call_id, str(exc))


def _materialize_parquet(
    *,
    source: str,
    table: str,
    fields: list[str],
    domain: list[Any],
    artifact_name: str,
    run_id: str,
    call_id: str,
    trace_id: str,
) -> ToolResult:
    """Export full dataset to Parquet in the run sandbox artifacts/ directory."""
    root = sandbox_root(run_id)
    artifacts_dir = root / "artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    out_path = artifacts_dir / artifact_name

    if source == "gpu":
        cols_line = ""
        if fields:
            cols_line = f"cols = [c for c in {fields!r} if c in df.columns]\ndf = df[cols]\n"

        count_script = f"df = gf('{table}')\n{cols_line}result = len(df)\n"
        try:
            t0 = time.time()
            count_resp = httpx.post(
                f"{_settings.rapids_url}/execute",
                json={"script": count_script},
                timeout=30,
            )
            _outbound_log("rapids/execute", t0, count_resp.status_code, trace_id=trace_id)
            total_rows = count_resp.json().get("result", 0) if count_resp.status_code == 200 else 0
        except Exception:
            total_rows = 0

        import pandas as pd
        all_dfs = []
        batch_size = 10000
        offset = 0

        while True:
            batch_script = (
                f"import json\n"
                f"df = gf('{table}')\n"
                f"{cols_line}"
                f"df = df.iloc[{offset}:{offset + batch_size}]\n"
                f"result = df.to_pandas().to_dict(orient='records')\n"
            )
            t0 = time.time()
            try:
                resp = httpx.post(
                    f"{_settings.rapids_url}/execute",
                    json={"script": batch_script},
                    timeout=120,
                )
                _outbound_log("rapids/execute", t0, resp.status_code, trace_id=trace_id)
                if resp.status_code != 200 or not resp.json().get("ok"):
                    break
                rows = resp.json().get("result", [])
                if not rows:
                    break
                all_dfs.append(pd.DataFrame(rows))
                offset += len(rows)
                if len(rows) < batch_size:
                    break
            except Exception:
                break

        if not all_dfs:
            return ToolResult(
                call_id=call_id,
                tool_name="query_data",
                status="failed",
                observation_for_model=_wrap_observation("query_data", call_id, f"Failed to fetch data from GPU frame '{table}'."),
            )

        df = pd.concat(all_dfs, ignore_index=True)
        df.to_parquet(out_path, index=False)

    elif source == "odoo":
        try:
            import pandas as pd

            batch_size = 5000
            all_rows: list[dict] = []
            offset = 0
            while True:
                batch = _odoo_call_kw(
                    table, "search_read",
                    args=[domain or []],
                    kwargs={"fields": fields or [], "limit": batch_size, "offset": offset, "order": "id asc"},
                    trace_id=trace_id,
                )
                if not batch:
                    break
                all_rows.extend(batch)
                offset += len(batch)
                if len(batch) < batch_size:
                    break
            df = pd.DataFrame(all_rows)
            df.to_parquet(out_path, index=False)
        except Exception as exc:
            return _odoo_unavailable_result(call_id, str(exc))
    else:
        return ToolResult(
            call_id=call_id,
            tool_name="query_data",
            status="failed",
            observation_for_model=_wrap_observation(
                "query_data", call_id, f"Unknown source '{source}' for full export."
            ),
        )

    raw = out_path.read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()
    size = len(raw)
    artifact_id = str(uuid.uuid4())
    manifest = {
        "artifact_id": artifact_id,
        "name": artifact_name,
        "path": str(out_path),
        "sha256": sha256,
        "size_bytes": size,
        "source": source,
        "table": table,
        "description": f"Full export of {source}/{table}",
    }

    msg = (
        f"Parquet artifact created: {artifact_name}\n"
        f"Path: {out_path}\n"
        f"SHA-256: {sha256}\n"
        f"Size: {size:,} bytes\n"
        f"Use execute_python with: import pandas as pd; df = pd.read_parquet('{out_path}')"
    )
    return ToolResult(
        call_id=call_id,
        tool_name="query_data",
        status="completed",
        observation_for_model=_wrap_observation("query_data", call_id, msg),
        artifacts=[manifest],
        raw_output=manifest,
    )
