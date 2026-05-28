from __future__ import annotations

from sqlalchemy import select

from ghostdash_api import control_api
from ghostdash_api.agent_memory import seed_default_agent_profiles
from ghostdash_api.models import AgentProfileRecord
from ghostdash_api.runtime_profiles import seed_default_runtime_profile
from ghostdash_api.workflow_runs import seed_workflow_definitions
from test_connections_and_bootstrap import build_client


def _seed_workflow_runtime(SessionLocal) -> tuple[list[str], str]:
    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        seed_default_agent_profiles(session)
        seed_workflow_definitions(session)
        agents = list(
            session.scalars(
                select(AgentProfileRecord)
                .where(AgentProfileRecord.enabled.is_(True))
                .order_by(AgentProfileRecord.is_default.desc(), AgentProfileRecord.updated_at.desc())
            )
        )
        assert len(agents) >= 2
        head_agent = next(agent for agent in agents if agent.is_default)
        return [agents[0].id, agents[1].id], head_agent.id


def test_api_create_workflow_run_persists_requested_workflow_mode(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    agent_ids, head_agent_id = _seed_workflow_runtime(SessionLocal)

    response = client.post(
        "/api/workflows/runs",
        json={
            "workflow_id": "mas_consult_v1",
            "surface": "ghost_chatui",
            "prompt": "Build a financial and strategy brief.",
            "agent_ids": agent_ids,
            "head_agent_id": head_agent_id,
            "api_mode": "responses",
            "conversation_mode": "working_session",
            "workflow_mode": "documenter",
            "use_approved_web": False,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["result_json"]["request"]["workflow_mode"] == "documenter"
    assert payload["result_json"]["request"]["conversation_mode"] == "working_session"


def test_api_execute_workflow_run_persists_workflow_mode_before_schedule(monkeypatch) -> None:
    scheduled_run_ids: list[str] = []
    monkeypatch.setattr(control_api, "schedule_workflow_run_execution", lambda run_id: scheduled_run_ids.append(run_id))
    client, SessionLocal = build_client(monkeypatch)
    agent_ids, head_agent_id = _seed_workflow_runtime(SessionLocal)

    response = client.post(
        "/api/workflows/runs/execute",
        json={
            "workflow_id": "mas_consult_v1",
            "surface": "ghost_chatui",
            "prompt": "Build a delegated workflow summary.",
            "agent_ids": agent_ids,
            "head_agent_id": head_agent_id,
            "api_mode": "responses",
            "conversation_mode": "quick",
            "workflow_mode": "odoo_specialist",
            "use_approved_web": False,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["result_json"]["request"]["workflow_mode"] == "odoo_specialist"
    assert len(scheduled_run_ids) == 1
    assert scheduled_run_ids[0] == payload["id"]
