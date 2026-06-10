from __future__ import annotations

from fastapi.testclient import TestClient

from ghostdash_api import control_api, voice_ingress
from ghostdash_api.hubtiger_customer_lookup import (
    _extract_job_context,
    extract_customer_name,
    normalize_phone_for_customer_search,
)
from ghostdash_api.schemas import HubTigerCustomerByPhoneResponse


def test_normalize_phone_for_customer_search_au_mobile() -> None:
    assert normalize_phone_for_customer_search("+61435185134") == "0435185134"
    assert normalize_phone_for_customer_search("0435185134") == "0435185134"
    assert normalize_phone_for_customer_search("61435185134") == "0435185134"
    assert normalize_phone_for_customer_search("+61404858688") == "0404858688"
    assert normalize_phone_for_customer_search("0404858688") == "0404858688"
    assert normalize_phone_for_customer_search("61404858688") == "0404858688"
    assert normalize_phone_for_customer_search("404858688") == "0404858688"


def test_extract_customer_name_from_hubtiger_row() -> None:
    first, last = extract_customer_name({"Name": "Jeff", "Surname": "Hall"})
    assert first == "Jeff"
    assert last == "Hall"


def test_extract_job_context_from_variables() -> None:
    model, jobcard, date_checked_in, location = _extract_job_context(
        {},
        {
            "Model": "VSETT APEX 10+",
            "Jobcard": "#36658",
            "DateCheckedIn": "2026-05-23T13:40:00",
            "Location": "Ride Electric",
        },
    )
    assert model == "VSETT APEX 10+"
    assert jobcard == "36658"
    assert date_checked_in == "2026-05-23T13:40:00"
    assert location == "Ride Electric"


def test_customer_by_phone_requires_voice_key(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hook-secret")

    response = client.post(
        "/api/elevenlabs/hubtiger/customer-by-phone",
        json={"phone": "0435185134"},
    )
    assert response.status_code == 401


def test_customer_by_phone_returns_names(monkeypatch) -> None:
    app = control_api.create_app()
    client = TestClient(app)
    monkeypatch.setattr(voice_ingress.settings, "elevenlabs_hubtiger_webhook_secret", "hook-secret")

    async def fake_lookup(*, phone: str, trace_id: str) -> HubTigerCustomerByPhoneResponse:
        assert phone == "0435185134"
        return HubTigerCustomerByPhoneResponse(
            success=True,
            found=True,
            message="Customer found.",
            phone="0435185134",
            first_name="Jeff",
            last_name="Hall",
            customer_id="12345",
            model="VSETT APEX 10+",
            jobcard="36658",
            date_checked_in="2026-05-23T13:40:00",
            location="Ride Electric",
            name="Jeff Hall",
            Name="Jeff Hall",
            Jobcard="36658",
            Model="VSETT APEX 10+",
            Workshop="Ride Electric",
            Location="Ride Electric",
            DateCheckedIn="2026-05-23T13:40:00",
        )

    monkeypatch.setattr(
        "ghostdash_api.integrations.hubtiger_elevenlabs_tool.lookup_customer_by_phone",
        fake_lookup,
    )

    response = client.post(
        "/api/elevenlabs/hubtiger/customer-by-phone",
        headers={"X-Ghost-Voice-Key": "hook-secret"},
        json={"phone": "0435185134"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["found"] is True
    assert body["first_name"] == "Jeff"
    assert body["last_name"] == "Hall"
    assert body["model"] == "VSETT APEX 10+"
    assert body["jobcard"] == "36658"
    assert body["date_checked_in"] == "2026-05-23T13:40:00"
    assert body["location"] == "Ride Electric"
