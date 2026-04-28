from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ghostdash_api.agent_memory import save_agent, seed_default_agent_profiles
from ghostdash_api.database import Base
from ghostdash_api.runtime_profiles import get_default_runtime_profile, seed_default_runtime_profile
from ghostdash_api.workflow_runs import (
    create_workflow_run,
    list_workflow_run_events,
    list_workflow_steps,
    list_workflow_tasks,
    seed_workflow_definitions,
    update_workflow_step_run,
)


def build_session():
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    return SessionLocal


def test_create_workflow_run_persists_task_graph_and_seed_events() -> None:
    SessionLocal = build_session()
    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        default_profile_id = get_default_runtime_profile(session).id
        seed_default_agent_profiles(session)
        seed_workflow_definitions(session)
        sub = save_agent(
            session,
            {
                "name": "Sub",
                "first_message": "Sub ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
                "runtime_profile_id": default_profile_id,
            },
        )
        sub_two = save_agent(
            session,
            {
                "name": "Sub Two",
                "first_message": "Sub two ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
                "runtime_profile_id": default_profile_id,
            },
        )
        lead = next(agent for agent in session.query(type(sub)).all() if agent.is_default)
        run = create_workflow_run(
            session,
            workflow_id="mas_consult_v1",
            surface="ghost_chatui",
            prompt="Assess financial health.",
            agent_ids=[sub.id, sub_two.id],
            head_agent_id=lead.id,
        )
        tasks = list_workflow_tasks(session, run.id)
        events = list_workflow_run_events(session, run.id)
    assert len(tasks) == 3
    assert any(task.task_kind == "child_agent" for task in tasks)
    assert any(task.task_kind == "head_synthesis" for task in tasks)
    assert [event.event_type for event in events[:2]] == ["RUN_CREATED", "PLAN_GRAPH_CREATED"]


def test_step_status_transition_updates_task_and_appends_event() -> None:
    SessionLocal = build_session()
    with SessionLocal() as session:
        seed_default_runtime_profile(session)
        default_profile_id = get_default_runtime_profile(session).id
        seed_default_agent_profiles(session)
        seed_workflow_definitions(session)
        sub = save_agent(
            session,
            {
                "name": "Sub",
                "first_message": "Sub ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
                "runtime_profile_id": default_profile_id,
            },
        )
        sub_two = save_agent(
            session,
            {
                "name": "Sub Two",
                "first_message": "Sub two ready.",
                "language": "en-US",
                "voice_id": "alloy",
                "is_default": False,
                "enabled": True,
                "runtime_profile_id": default_profile_id,
            },
        )
        lead = next(agent for agent in session.query(type(sub)).all() if agent.is_default)
        run = create_workflow_run(
            session,
            workflow_id="mas_consult_v1",
            surface="ghost_chatui",
            prompt="Assess financial health.",
            agent_ids=[sub.id, sub_two.id],
            head_agent_id=lead.id,
        )
        child_step = next(step for step in list_workflow_steps(session, run.id) if step.node_type == "child_agent")
        update_workflow_step_run(session, run_id=run.id, step_id=child_step.id, status="running")
        update_workflow_step_run(session, run_id=run.id, step_id=child_step.id, status="completed", output_text="Done.")
        tasks = list_workflow_tasks(session, run.id)
        child_task = next(task for task in tasks if task.step_run_id == child_step.id)
        event_types = [event.event_type for event in list_workflow_run_events(session, run.id)]
    assert child_task.status == "completed"
    assert "TASK_STARTED" in event_types
    assert "TASK_COMPLETED" in event_types

