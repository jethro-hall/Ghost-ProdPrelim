"""
Database access layer — agent runtime tables only.
Uses psycopg (v3) directly; no ORM overhead.
"""
from __future__ import annotations

import json
import logging
from contextlib import contextmanager
from typing import Any, Generator, Iterator

import psycopg
from psycopg.rows import dict_row

from .config import get_settings

logger = logging.getLogger(__name__)
_settings = get_settings()


@contextmanager
def get_conn() -> Generator[psycopg.Connection, None, None]:
    # Convert SQLAlchemy-style URL to psycopg conninfo
    db_url = _settings.db_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(db_url, row_factory=dict_row) as conn:
        yield conn


def run_migrations() -> None:
    """Apply SQL migrations idempotently at startup."""
    import pathlib

    migrations_dir = pathlib.Path(__file__).parent / "migrations"
    files = sorted(migrations_dir.glob("*.sql"))
    with get_conn() as conn:
        for f in files:
            logger.info("Applying migration: %s", f.name)
            conn.execute(f.read_text())
        conn.commit()
    logger.info("Migrations complete — %d file(s)", len(files))


# ── AgentRun ──────────────────────────────────────────────────────────────────

def insert_agent_run(
    *,
    run_id: str,
    question: str,
    mode: str = "agent",
    model: str,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO agent_runs (id, mode, model, question, status)
            VALUES (%s, %s, %s, %s, 'queued')
            """,
            (run_id, mode, model, question),
        )
        conn.commit()


def get_agent_run(run_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM agent_runs WHERE id = %s", (run_id,)
        ).fetchone()
    return dict(row) if row else None


def update_agent_run_status(run_id: str, status: str, error: str | None = None) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE agent_runs
               SET status = %s,
                   completed_at = CASE WHEN %s IN ('completed','failed') THEN NOW() ELSE NULL END,
                   error = %s
             WHERE id = %s
            """,
            (status, status, error, run_id),
        )
        conn.commit()


def update_agent_run_summary(run_id: str, summary: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE agent_runs SET summary = %s WHERE id = %s",
            (summary, run_id),
        )
        conn.commit()


def update_agent_run_trace_id(run_id: str, trace_id: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE agent_runs SET trace_id = %s WHERE id = %s",
            (trace_id, run_id),
        )
        conn.commit()


# ── RunEvents ─────────────────────────────────────────────────────────────────

def insert_run_event(
    *,
    event_id: str,
    run_id: str,
    seq: int,
    event_type: str,
    title: str | None = None,
    payload: dict[str, Any] | None = None,
    visible: bool = True,
    parent_event_id: str | None = None,
    status: str | None = None,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO agent_run_events
              (id, run_id, seq, parent_event_id, type, status, title, payload, visible)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (run_id, seq) DO NOTHING
            """,
            (
                event_id, run_id, seq, parent_event_id,
                event_type, status, title,
                json.dumps(payload) if payload else None,
                visible,
            ),
        )
        conn.commit()


def get_run_events(run_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM agent_run_events
             WHERE run_id = %s AND seq > %s
             ORDER BY seq
            """,
            (run_id, after_seq),
        ).fetchall()
    result = []
    for row in rows:
        d = dict(row)
        if isinstance(d.get("payload"), str):
            try:
                d["payload"] = json.loads(d["payload"])
            except Exception:
                pass
        result.append(d)
    return result


def next_seq(run_id: str) -> int:
    """Return next sequence number for run events (thread-safe via DB sequence)."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS nxt FROM agent_run_events WHERE run_id = %s",
            (run_id,),
        ).fetchone()
    return row["nxt"] if row else 1


# ── ToolCalls ─────────────────────────────────────────────────────────────────

def insert_tool_call(
    *,
    tc_id: str,
    run_id: str,
    call_id: str,
    tool_name: str,
    args: dict[str, Any],
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO agent_tool_calls
              (id, run_id, call_id, tool_name, args, status, started_at)
            VALUES (%s, %s, %s, %s, %s, 'running', NOW())
            """,
            (tc_id, run_id, call_id, tool_name, json.dumps(args)),
        )
        conn.commit()


def complete_tool_call(
    *,
    tc_id: str,
    status: str,
    output_ref: str | None = None,
    exit_code: int | None = None,
    error: str | None = None,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            UPDATE agent_tool_calls
               SET status = %s, completed_at = NOW(), output_ref = %s,
                   exit_code = %s, error = %s
             WHERE id = %s
            """,
            (status, output_ref, exit_code, error, tc_id),
        )
        conn.commit()


# ── Artifacts ─────────────────────────────────────────────────────────────────

def insert_artifact(
    *,
    artifact_id: str,
    run_id: str,
    path: str,
    name: str,
    mime_type: str = "application/octet-stream",
    sha256: str,
    size_bytes: int,
    description: str = "",
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO agent_artifacts
              (id, run_id, path, name, mime_type, sha256, size_bytes, description)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (artifact_id, run_id, path, name, mime_type, sha256, size_bytes, description),
        )
        conn.commit()


def get_artifacts(run_id: str) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM agent_artifacts WHERE run_id = %s ORDER BY created_at",
            (run_id,),
        ).fetchall()
    return [dict(r) for r in rows]


# ── Approvals ─────────────────────────────────────────────────────────────────

def insert_approval(
    *,
    approval_id: str,
    run_id: str,
    tool_call_id: str,
    risk_level: str,
    request: dict[str, Any],
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO agent_approvals
              (id, run_id, tool_call_id, risk_level, request)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (approval_id, run_id, tool_call_id, risk_level, json.dumps(request)),
        )
        conn.commit()


def resolve_approval(approval_id: str, decision: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE agent_approvals SET decision = %s, decided_at = NOW() WHERE id = %s",
            (decision, approval_id),
        )
        conn.commit()


def get_approval_decision(approval_id: str) -> str | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT decision FROM agent_approvals WHERE id = %s",
            (approval_id,),
        ).fetchone()
    return row["decision"] if row else None


# ── VerificationReviews ───────────────────────────────────────────────────────

def insert_verification_review(
    *,
    review_id: str,
    run_id: str,
    status: str,
    confidence: float,
    defects: list[str],
    required_remediation: list[str],
    summary: str,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO agent_verification_reviews
              (id, run_id, status, confidence, defects, required_remediation, summary)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                review_id, run_id, status, confidence,
                json.dumps(defects), json.dumps(required_remediation), summary,
            ),
        )
        conn.commit()
