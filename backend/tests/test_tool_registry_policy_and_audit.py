from __future__ import annotations

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from ghostdash_api.database import Base
from ghostdash_api.models import ToolExecutionAuditRecord
from ghostdash_api.tool_registry import execute_tool_operation, get_or_create_odoo_registry


def build_session():
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    return SessionLocal


def test_execute_tool_operation_requires_approval_for_destructive(monkeypatch) -> None:
    SessionLocal = build_session()
    with SessionLocal() as session:
        record = get_or_create_odoo_registry(session)
        record.config_json = {
            "base_url": "https://odoo.example.com",
            "database": "db",
            "username": "user",
            "password": "pass",
            "read_only": True,
            "timeout_ms": 30000,
            "execute_path": "/api/tools/odoo_primary/execute",
            "health_path": "/health",
        }
        session.add(record)
        session.commit()
        monkeypatch.setattr(
            "ghostdash_api.tool_registry.execute_odoo_operation",
            lambda *_args, **_kwargs: {
                "success": True,
                "message": "ok",
                "operation": "odoo.rpc.execute_kw",
                "data": {},
            },
        )
        response = execute_tool_operation(session, "odoo_primary", operation="odoo.rpc.execute_kw", payload={})
        assert response.success is False
        assert response.requires_approval is True
        assert response.approved is False
        audit = session.scalar(select(ToolExecutionAuditRecord).order_by(ToolExecutionAuditRecord.created_at.desc()))
        assert audit is not None
        assert audit.status == "blocked"
        assert audit.requires_approval is True


def test_execute_tool_operation_dry_run_writes_audit_entry(monkeypatch) -> None:
    SessionLocal = build_session()
    with SessionLocal() as session:
        record = get_or_create_odoo_registry(session)
        record.config_json = {
            "base_url": "https://odoo.example.com",
            "database": "db",
            "username": "user",
            "password": "pass",
            "read_only": True,
            "timeout_ms": 30000,
            "execute_path": "/api/tools/odoo_primary/execute",
            "health_path": "/health",
        }
        session.add(record)
        session.commit()
        monkeypatch.setattr(
            "ghostdash_api.tool_registry.execute_odoo_operation",
            lambda *_args, **_kwargs: {
                "success": True,
                "message": "ok",
                "operation": "odoo.meta.current_user",
                "data": {},
            },
        )
        response = execute_tool_operation(
            session,
            "odoo_primary",
            operation="odoo.meta.current_user",
            payload={},
            dry_run=True,
        )
        assert response.success is True
        assert response.data.get("dry_run") is True
        audit = session.scalar(select(ToolExecutionAuditRecord).order_by(ToolExecutionAuditRecord.created_at.desc()))
        assert audit is not None
        assert audit.status == "dry_run"

