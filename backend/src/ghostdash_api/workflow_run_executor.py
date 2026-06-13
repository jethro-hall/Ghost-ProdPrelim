from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

import httpx
from sqlalchemy import select

from .database import SessionLocal
from .memory_service import memory_service
from .models import WorkflowRunRecord
from .settings import get_settings
from .workflow_runs import (
    STEP_TERMINAL_STATUSES,
    RUN_TERMINAL_STATUSES,
    append_workflow_run_event,
    get_workflow_run,
    list_workflow_steps,
    update_workflow_run,
    update_workflow_step_run,
)

settings = get_settings()

ACTIVE_WORKFLOW_RUN_TASKS: dict[str, asyncio.Task[None]] = {}
RECOVERY_INTERRUPTED_MESSAGE = "Workflow execution was interrupted by control-api restart before completion."

ConsultRunner = Callable[..., Any]


async def default_consult_runner(
    *,
    message: str,
    agent_id: str,
    conversation_id: str | None,
    api_mode: str,
    conversation_mode: str,
    workflow_mode: str,
    use_approved_web: bool,
    tool_overrides: dict[str, bool] | None = None,
) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=300.0) as client:
        response = await client.post(
            f"{settings.app_agent_ingress_base_url.rstrip('/')}/agent/chat",
            json={
                "message": message,
                "agent_id": agent_id,
                "conversation_id": conversation_id,
                "api_mode": api_mode,
                "conversation_mode": conversation_mode,
                "workflow_mode": workflow_mode,
                "use_approved_web": use_approved_web,
                "tool_overrides": dict(tool_overrides or {}),
            },
        )
        response.raise_for_status()
        return response.json()


def render_workflow_prompt_template(template: str, *, workflow_name: str, user_prompt: str, child_results: str) -> str:
    rendered = str(template or "").replace("{{workflow_name}}", workflow_name)
    rendered = rendered.replace("{{user_prompt}}", user_prompt)
    rendered = rendered.replace("{{child_results}}", child_results)
    return rendered


def build_child_results_text(steps) -> str:
    child_blocks: list[str] = []
    for step in steps:
        if step.node_type != "child_agent":
            continue
        if step.status not in {"completed", "failed"}:
            continue
        label = step.agent_name or step.agent_id or step.node_id
        outcome = step.output_text or step.error_message or "No output captured."
        child_blocks.append(f"{label}:\n{outcome}")
    return "\n\n".join(child_blocks).strip()


def initialize_workflow_run_executor_state(*, session_factory=SessionLocal) -> None:
    ACTIVE_WORKFLOW_RUN_TASKS.clear()
    with session_factory() as session:
        runs = list(
            session.scalars(
                select(WorkflowRunRecord)
                .where(WorkflowRunRecord.status.in_(("queued", "running")))
                .order_by(WorkflowRunRecord.created_at.asc())
            )
        )
        if not runs:
            return
        for run in runs:
            for step in list_workflow_steps(session, run.id):
                if step.status not in STEP_TERMINAL_STATUSES:
                    step.status = "aborted"
                    step.completed_at = step.completed_at or run.updated_at
            run.status = "failed"
            run.current_step = "completed"
            run.progress = 1.0
            run.error_message = RECOVERY_INTERRUPTED_MESSAGE
            run.completed_at = run.completed_at or run.updated_at
        session.commit()


def schedule_workflow_run_execution(
    run_id: str,
    *,
    consult_runner: ConsultRunner = default_consult_runner,
    session_factory=SessionLocal,
) -> str:
    existing = ACTIVE_WORKFLOW_RUN_TASKS.get(run_id)
    if existing is not None and not existing.done():
        return "already_running"

    task = asyncio.create_task(
        execute_workflow_run(
            run_id,
            consult_runner=consult_runner,
            session_factory=session_factory,
        )
    )
    ACTIVE_WORKFLOW_RUN_TASKS[run_id] = task
    return "queued"


async def cancel_workflow_run_execution(run_id: str, *, session_factory=SessionLocal) -> None:
    task = ACTIVE_WORKFLOW_RUN_TASKS.get(run_id)
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    with session_factory() as session:
        run = get_workflow_run(session, run_id)
        if run.status not in RUN_TERMINAL_STATUSES:
            update_workflow_run(
                session,
                run_id=run_id,
                status="aborted",
                error_message="Workflow aborted by user.",
            )


async def execute_workflow_run(
    run_id: str,
    *,
    consult_runner: ConsultRunner = default_consult_runner,
    session_factory=SessionLocal,
) -> None:
    completed_agents = 0
    failed_agents = 0
    try:
        with session_factory() as session:
            run = get_workflow_run(session, run_id)
            steps = list_workflow_steps(session, run.id)
            request_config = dict((run.result_json or {}).get("request", {}))
            workflow_config = dict((run.result_json or {}).get("workflow", {}))
            prompt = run.prompt
            api_mode = str(request_config.get("api_mode") or "responses")
            conversation_mode = str(request_config.get("conversation_mode") or "quick")
            workflow_mode = str(request_config.get("workflow_mode") or "standard")
            use_approved_web = bool(request_config.get("use_approved_web"))
            tool_overrides = dict(request_config.get("tool_overrides") or {})
            workflow_name = str(workflow_config.get("name") or run.workflow_id)

        for step in steps:
            with session_factory() as session:
                current_run = get_workflow_run(session, run_id)
                if current_run.status == "aborted":
                    break
                current_step = next((entry for entry in list_workflow_steps(session, run_id) if entry.id == step.id), None)
                if current_step is None or current_step.status in STEP_TERMINAL_STATUSES:
                    continue
                update_workflow_step_run(
                    session,
                    run_id=run_id,
                    step_id=step.id,
                    status="running",
                    metadata_json={
                        **(current_step.metadata_json or {}),
                        "executor": "control-api",
                        "lease_id": f"{run_id}:{step.id}",
                    },
                )
                memory_service.set_working_memory(
                    f"run:{run_id}:active_task",
                    {
                        "step_id": current_step.id,
                        "task_key": f"{current_step.node_id}:{current_step.sequence}",
                        "agent_id": current_step.agent_id,
                        "status": "running",
                    },
                    ttl_seconds=int(settings.app_working_memory_ttl_seconds),
                )
                append_workflow_run_event(
                    session,
                    run_id=run_id,
                    event_type="TASK_DISPATCHED",
                    task_key=f"{current_step.node_id}:{current_step.sequence}",
                    actor_id=current_step.agent_id,
                    metadata_json={
                        "step_id": current_step.id,
                        "worker_type": "agent_ingress_consult_runner",
                        "retry_budget": int((request_config.get("retry_budget") or 1)),
                    },
                )
                step_conversation_id = current_step.conversation_id
                step_prompt = render_workflow_prompt_template(
                    str((current_step.metadata_json or {}).get("prompt_template") or current_run.prompt),
                    workflow_name=workflow_name,
                    user_prompt=prompt,
                    child_results=build_child_results_text(list_workflow_steps(session, run_id)),
                )

            try:
                result = await consult_runner(
                    message=step_prompt,
                    agent_id=step.agent_id,
                    conversation_id=step_conversation_id,
                    api_mode=api_mode,
                    conversation_mode=conversation_mode,
                    workflow_mode=workflow_mode,
                    use_approved_web=use_approved_web,
                    tool_overrides=tool_overrides,
                )
                with session_factory() as session:
                    update_workflow_step_run(
                        session,
                        run_id=run_id,
                        step_id=step.id,
                        status="completed",
                        conversation_id=result.get("conversation_id"),
                        output_text=result.get("answer") or "",
                        citations=result.get("citations") or [],
                        metadata_json={
                            "query_mode": result.get("query_mode"),
                            "conversation_mode": result.get("conversation_mode") or conversation_mode,
                            "workflow_mode": result.get("workflow_mode") or workflow_mode,
                            "cached": bool(result.get("cached")),
                            "usage": result.get("usage"),
                        },
                    )
                    if workflow_mode == "bp_mode":
                        append_workflow_run_event(
                            session,
                            run_id=run_id,
                            event_type="BP_AUDIT_EVALUATED",
                            task_key=f"{step.node_id}:{step.sequence}",
                            actor_id=step.agent_id,
                            metadata_json={
                                "step_id": step.id,
                                "step_status": "completed",
                                "hard_fail": False,
                            },
                        )
                completed_agents += 1
            except asyncio.CancelledError:
                with session_factory() as session:
                    update_workflow_run(
                        session,
                        run_id=run_id,
                        status="aborted",
                        error_message="Workflow aborted by user.",
                    )
                raise
            except Exception as exc:
                failed_agents += 1
                with session_factory() as session:
                    if workflow_mode == "bp_mode":
                        append_workflow_run_event(
                            session,
                            run_id=run_id,
                            event_type="BP_AUDIT_FAILED",
                            task_key=f"{step.node_id}:{step.sequence}",
                            actor_id=step.agent_id,
                            metadata_json={
                                "step_id": step.id,
                                "step_status": "failed",
                                "hard_fail": True,
                                "error": str(exc)[:500],
                            },
                        )
                    append_workflow_run_event(
                        session,
                        run_id=run_id,
                        event_type="TASK_FAILED",
                        task_key=f"{step.node_id}:{step.sequence}",
                        actor_id=step.agent_id,
                        metadata_json={
                            "step_id": step.id,
                            "error": str(exc)[:500],
                        },
                    )
                    update_workflow_step_run(
                        session,
                        run_id=run_id,
                        step_id=step.id,
                        status="failed",
                        error_message=str(exc)[:2000],
                        metadata_json={
                            "executor": "control-api",
                            "conversation_mode": conversation_mode,
                            "workflow_mode": workflow_mode,
                        },
                    )

        with session_factory() as session:
            run = get_workflow_run(session, run_id)
            if run.status != "aborted":
                update_workflow_run(
                    session,
                    run_id=run_id,
                    result_json={
                        "completed_agents": completed_agents,
                        "failed_agents": failed_agents,
                    },
                )
                if workflow_mode == "bp_mode":
                    append_workflow_run_event(
                        session,
                        run_id=run_id,
                        event_type="BP_AUDIT_PASSED" if failed_agents == 0 else "BP_AUDIT_FAILED",
                        actor_id=None,
                        metadata_json={
                            "completed_agents": completed_agents,
                            "failed_agents": failed_agents,
                            "hard_fail": failed_agents > 0,
                        },
                    )
                snapshot = memory_service.build_episodic_snapshot(session, run_id)
                memory_service.set_working_memory(
                    f"run:{run_id}:episodic_snapshot",
                    {"events": snapshot[-30:]},
                    ttl_seconds=int(settings.app_working_memory_ttl_seconds),
                )
                memory_service.promote_semantic_memory(
                    run_id=run_id,
                    content="\n".join(
                        f"[{item['sequence']}] {item['event_type']}: {item['metadata']}"
                        for item in snapshot[-20:]
                    ),
                    metadata={
                        "workflow_id": run.workflow_id,
                        "status": run.status,
                        "surface": run.surface,
                    },
                )
    finally:
        ACTIVE_WORKFLOW_RUN_TASKS.pop(run_id, None)
