from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from ghostdash_api import workflow_runtime


def make_run(*, run_id: str, corpus: str, created_at: datetime):
    return SimpleNamespace(
        id=run_id,
        corpus=corpus,
        created_at=created_at,
    )


def test_split_recoverable_ingestion_runs_keeps_latest_per_corpus() -> None:
    now = datetime.now(UTC)
    older_default = make_run(run_id="run-1", corpus="default", created_at=now)
    newer_default = make_run(run_id="run-2", corpus="default", created_at=now + timedelta(minutes=1))
    other_corpus = make_run(run_id="run-3", corpus="finance", created_at=now + timedelta(minutes=2))

    recoverable, superseded = workflow_runtime.split_recoverable_ingestion_runs(
        [older_default, newer_default, other_corpus]
    )

    assert [run.id for run in recoverable] == ["run-2", "run-3"]
    assert [run.id for run in superseded] == ["run-1"]


def test_split_recoverable_ingestion_runs_returns_all_when_corpora_are_unique() -> None:
    now = datetime.now(UTC)
    default_run = make_run(run_id="run-1", corpus="default", created_at=now)
    finance_run = make_run(run_id="run-2", corpus="finance", created_at=now + timedelta(minutes=1))

    recoverable, superseded = workflow_runtime.split_recoverable_ingestion_runs([default_run, finance_run])

    assert [run.id for run in recoverable] == ["run-1", "run-2"]
    assert superseded == []
