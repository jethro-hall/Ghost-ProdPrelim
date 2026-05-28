from __future__ import annotations

from ghostdash_api.runtime_profiles import seed_default_runtime_profile

from test_connections_and_bootstrap import build_client


def _seed_runtime_profile_id(SessionLocal) -> str:
    with SessionLocal() as session:
        profile = seed_default_runtime_profile(session)
        session.commit()
        return profile.id


def test_create_sub_agent_normalizes_name_and_role(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    runtime_profile_id = _seed_runtime_profile_id(SessionLocal)

    lead_response = client.post(
        "/api/agents",
        json={
            "name": "Lead Planner",
            "first_message": "lead",
            "language": "en-US",
            "voice_id": "alloy",
            "runtime_profile_id": runtime_profile_id,
            "agent_role": "lead",
            "enabled": True,
        },
    )
    assert lead_response.status_code == 200
    lead = lead_response.json()

    sub_response = client.post(
        "/api/agents",
        json={
            "name": "Research Worker",
            "first_message": "sub",
            "language": "en-US",
            "voice_id": "alloy",
            "runtime_profile_id": runtime_profile_id,
            "agent_role": "sub",
            "parent_agent_id": lead["id"],
            "position": 1,
            "enabled": True,
        },
    )
    assert sub_response.status_code == 200
    sub = sub_response.json()
    assert sub["agent_role"] == "sub"
    assert sub["parent_agent_id"] == lead["id"]
    assert sub["position"] == 1
    assert sub["name"].startswith("[SA] ")


def test_sub_agent_requires_parent(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    runtime_profile_id = _seed_runtime_profile_id(SessionLocal)

    response = client.post(
        "/api/agents",
        json={
            "name": "No Parent",
            "first_message": "sub",
            "language": "en-US",
            "voice_id": "alloy",
            "runtime_profile_id": runtime_profile_id,
            "agent_role": "sub",
            "enabled": True,
        },
    )
    assert response.status_code == 400
    assert "parent_agent_id" in response.json()["detail"]


def test_agent_hierarchy_endpoint_groups_sub_agents(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    runtime_profile_id = _seed_runtime_profile_id(SessionLocal)

    lead_response = client.post(
        "/api/agents",
        json={
            "name": "Lead Strategy",
            "first_message": "lead",
            "language": "en-US",
            "voice_id": "alloy",
            "runtime_profile_id": runtime_profile_id,
            "agent_role": "lead",
            "enabled": True,
        },
    )
    assert lead_response.status_code == 200
    lead = lead_response.json()

    sub_response = client.post(
        "/api/agents",
        json={
            "name": "[SA] Data Worker",
            "first_message": "sub",
            "language": "en-US",
            "voice_id": "alloy",
            "runtime_profile_id": runtime_profile_id,
            "agent_role": "sub",
            "parent_agent_id": lead["id"],
            "position": 2,
            "enabled": True,
        },
    )
    assert sub_response.status_code == 200

    hierarchy_response = client.get("/api/agents/hierarchy")
    assert hierarchy_response.status_code == 200
    hierarchy = hierarchy_response.json()
    lead_entry = next((entry for entry in hierarchy if entry["lead_agent"]["id"] == lead["id"]), None)
    assert lead_entry is not None
    assert len(lead_entry["sub_agents"]) == 1
    assert lead_entry["sub_agents"][0]["agent_role"] == "sub"
    assert lead_entry["sub_agents"][0]["parent_agent_id"] == lead["id"]
