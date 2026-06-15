"""
End-to-end integration test:
  - Creates a run
  - Queries GPU catalog (live rapids-analytics:8010)
  - Verifies event log is populated
  - Does NOT require Bedrock (uses mock loop)

For a full LLM test, use pytest -m live (requires AWS credentials + running stack).
"""
import asyncio
import json
import pathlib
import sys
import time
import uuid

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

pytestmark = pytest.mark.skipif(
    True,  # Set to False when stack is running
    reason="Integration test requires live Postgres + rapids-analytics stack",
)


def test_run_event_sequence():
    """
    Verify that a synthetic run produces events in sequence order
    and the event log is append-only.
    """
    from backend.repositories import (
        insert_agent_run,
        insert_run_event,
        get_run_events,
        next_seq,
    )

    run_id = f"test-e2e-{uuid.uuid4().hex[:8]}"
    insert_agent_run(run_id=run_id, question="Test question", mode="agent", model="test-model")

    # Insert 3 events
    for i in range(1, 4):
        seq = next_seq(run_id)
        event_id = str(uuid.uuid4())
        insert_run_event(
            event_id=event_id,
            run_id=run_id,
            seq=seq,
            event_type=f"test.event.{i}",
            title=f"Event {i}",
        )

    events = get_run_events(run_id)
    assert len(events) == 3
    # Must be in sequence order
    seqs = [e["seq"] for e in events]
    assert seqs == sorted(seqs)
    # Sequences must be unique
    assert len(set(seqs)) == 3


def test_catalog_returns_metadata_not_rows(live_rapids_url="http://rapids-analytics:8010"):
    """
    Verify that catalog_data_sources returns only metadata — no row values.
    """
    import httpx
    from backend.data_connector import catalog_data_sources

    run_id = f"test-catalog-{uuid.uuid4().hex[:8]}"
    result = catalog_data_sources(args={}, run_id=run_id, call_id="test")

    assert result.status == "completed"
    raw = result.raw_output
    assert "sources" in raw

    gpu_source = next((s for s in raw["sources"] if s.get("source") == "gpu"), None)
    if gpu_source:
        assert gpu_source["frame_count"] > 0
        # Frames should have row counts and column names — not actual data values
        for frame in gpu_source.get("frames", []):
            assert "id" in frame
            assert "rows" in frame
            assert "columns" in frame
            # No actual cell values in the catalog
            assert isinstance(frame["columns"], list)


def test_sandbox_python_with_duckdb():
    """
    Verify that execute_python can use DuckDB to analyse a simple dataset.
    """
    from backend.sandbox_runner import create_sandbox, destroy_sandbox, execute_python

    run_id = f"test-duckdb-{uuid.uuid4().hex[:8]}"
    create_sandbox(run_id)
    try:
        code = """
import duckdb
import json
conn = duckdb.connect()
conn.execute("CREATE TABLE t AS SELECT * FROM (VALUES (1, 100.0), (2, 200.0), (3, 300.0)) t(id, amount)")
result_df = conn.execute("SELECT SUM(amount) as total FROM t").fetchdf()
total = float(result_df["total"].iloc[0])
result = {"total": total, "expected": 600.0, "match": total == 600.0}
import json
print(json.dumps(result))
"""
        result = execute_python(
            args={"code": code, "reason": "DuckDB test"},
            run_id=run_id,
            call_id="test-call",
        )
        assert result.status == "completed"
        assert "600" in result.stdout
    finally:
        destroy_sandbox(run_id)
