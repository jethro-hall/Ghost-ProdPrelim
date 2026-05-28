from __future__ import annotations

from sqlalchemy import select

from ghostdash_api.models import AgentProfileRecord, ConnectionRecord
from ghostdash_api.runtime import save_connection, seed_default_connections
from ghostdash_api.runtime_profiles import seed_default_runtime_profile

from test_connections_and_bootstrap import build_client


def _seed_runtime_state_with_connection_ref(SessionLocal):
    with SessionLocal() as session:
        seed_default_connections(session)
        profile = seed_default_runtime_profile(session)
        custom = save_connection(
            session,
            "temp-provider",
            label="Temp Provider",
            provider_kind="openai_compatible",
            auth_strategy="bearer",
            base_url="https://temp-provider.internal/v1",
            api_key="temp-key",
            enabled=True,
        )
        llm_config = dict(profile.llm_config_json or {})
        llm_config["connection_id"] = custom.id
        llm_config["provider"] = custom.provider
        profile.llm_config_json = llm_config
        session.add(
            AgentProfileRecord(
                name="Temp Agent",
                first_message="hello",
                language="en-US",
                voice_id="alloy",
                runtime_profile_id=profile.id,
                is_default=False,
                enabled=True,
            )
        )
        session.commit()
        return custom.id


def test_connection_deletion_preview_blocks_seeded_provider(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    with SessionLocal() as session:
        seed_default_connections(session)
        openai = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == "openai"))
        assert openai is not None
        openai_id = openai.id

    response = client.post(f"/api/connections/{openai_id}/deletion-preview")
    assert response.status_code == 200
    payload = response.json()
    assert payload["can_execute"] is False
    assert "seeded_provider_protected" in payload["blocking_reasons"]


def test_connection_deletion_preview_blocks_runtime_references(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    connection_id = _seed_runtime_state_with_connection_ref(SessionLocal)

    response = client.post(f"/api/connections/{connection_id}/deletion-preview")
    assert response.status_code == 200
    payload = response.json()
    assert payload["can_execute"] is False
    assert "runtime_profile_references" in payload["blocking_reasons"]
    assert payload["impact"]["runtime_profile_direct_refs"] >= 1
    assert payload["impact"]["agents_impacted"] >= 1


def test_connection_delete_round_trip_for_unreferenced_provider(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    with SessionLocal() as session:
        seed_default_connections(session)
        created = save_connection(
            session,
            "sandbox-provider",
            label="Sandbox Provider",
            provider_kind="openai_compatible",
            auth_strategy="bearer",
            base_url="https://sandbox.internal/v1",
            api_key="sandbox-key",
            enabled=True,
        )
        connection_id = created.id

    preview = client.post(f"/api/connections/{connection_id}/deletion-preview")
    assert preview.status_code == 200
    preview_payload = preview.json()
    assert preview_payload["can_execute"] is True
    token = preview_payload["confirmation_token"]

    delete_response = client.request(
        "DELETE",
        f"/api/connections/{connection_id}",
        params={"confirm": "true"},
        json={"confirmation_token": token},
    )
    assert delete_response.status_code == 200
    assert delete_response.json()["deleted"] is True

    list_response = client.get("/api/connections")
    assert list_response.status_code == 200
    providers = {row["provider"] for row in list_response.json()}
    assert "sandbox-provider" not in providers
