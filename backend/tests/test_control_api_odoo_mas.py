from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ghostdash_api import control_api
from ghostdash_api.database import Base, get_session


def _build_client(monkeypatch) -> TestClient:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(control_api, "initialize_control_runtime_state", lambda: None)

    def override_get_session():
        with SessionLocal() as session:
            yield session

    app = control_api.create_app()
    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app)


def test_odoo_mas_answer_endpoint(monkeypatch) -> None:
    client = _build_client(monkeypatch)

    def fake_pipeline(session, *, message: str, trace_id: str | None = None):
        return {"success": True, "message": message, "trace_id": trace_id}

    monkeypatch.setattr(control_api, "run_odoo_mas_pipeline", fake_pipeline)
    response = client.post("/api/odoo/mas/answer", json={"message": "Show March Burleigh revenue."})
    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert "Burleigh" in payload["message"]


def test_finance_report_endpoint_returns_payload(monkeypatch, tmp_path) -> None:
    client = _build_client(monkeypatch)
    report_dir = tmp_path / "finance_reports"
    report_dir.mkdir()
    (report_dir / "run-1.json").write_text('{"status": "ok"}')
    (report_dir / "run-1.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")
    (report_dir / "run-1.html").write_text("<html>ok</html>")
    monkeypatch.setattr("ghostdash_api.finance_report_renderer._report_dir", lambda: report_dir)

    response = client.get("/api/finance/reports/run-1")
    assert response.status_code == 200
    payload = response.json()
    assert payload["run_id"] == "run-1"
    assert payload["chat_payload"]["status"] == "ok"
    assert payload["report_url"] == "/api/finance/reports/run-1/pdf"

    pdf_response = client.get("/api/finance/reports/run-1/pdf")
    assert pdf_response.status_code == 200
    assert pdf_response.headers["content-type"] == "application/pdf"


def test_odoo_mas_ledger_classified_endpoint(monkeypatch) -> None:
    client = _build_client(monkeypatch)

    def fake_classified(session, *, entity: str, date_from: str, date_to: str):
        return {
            "status": "ok",
            "entity": entity,
            "date_from": date_from,
            "date_to": date_to,
            "rows": [
                {
                    "account": "518 Marketing - Advertising - Google",
                    "amount": 200.0,
                    "account_class": "marketing_direct",
                    "include_in_metric": True,
                },
                {
                    "account": "520 Contract Mechanic",
                    "amount": 900.0,
                    "account_class": "workshop_cost",
                    "include_in_metric": False,
                },
            ],
        }

    monkeypatch.setattr(control_api, "get_classified_ledger_rows", fake_classified)
    response = client.post(
        "/api/odoo/mas/ledger/classified",
        json={"entity": "brisbane", "date_from": "2026-03-01", "date_to": "2026-04-01"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert len(payload["rows"]) == 2
    assert payload["rows"][1]["account"] == "520 Contract Mechanic"
