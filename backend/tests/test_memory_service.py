from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ghostdash_api.database import Base
from ghostdash_api.memory_service import MemoryService
from ghostdash_api.models import WorkflowRunEventRecord


def build_session():
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    return SessionLocal


def test_memory_service_uses_fallback_store_without_redis() -> None:
    service = MemoryService()
    service._redis = None  # type: ignore[attr-defined]
    service.set_working_memory("run:test", {"status": "running"}, ttl_seconds=30)
    assert service.get_working_memory("run:test") == {"status": "running"}


def test_build_episodic_snapshot_reads_run_events() -> None:
    SessionLocal = build_session()
    with SessionLocal() as session:
        session.add(
            WorkflowRunEventRecord(
                run_id="run-1",
                sequence=1,
                event_type="RUN_CREATED",
                metadata_json={"workflow_id": "mas_consult_v1"},
            )
        )
        session.commit()
        service = MemoryService()
        snapshot = service.build_episodic_snapshot(session, "run-1")
    assert len(snapshot) == 1
    assert snapshot[0]["event_type"] == "RUN_CREATED"

