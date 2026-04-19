from __future__ import annotations

from copy import deepcopy
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    AgentProfileRecord,
    WorkflowDefinitionRecord,
    WorkflowRunEventRecord,
    WorkflowRunRecord,
    WorkflowStepRunRecord,
    WorkflowTaskRecord,
    utc_now,
)

STEP_TERMINAL_STATUSES = {"completed", "failed", "aborted"}
RUN_TERMINAL_STATUSES = {"completed", "completed_with_errors", "failed", "aborted"}
SUPPORTED_WORKFLOW_NODE_TYPES = {"child_agent", "head_agent_synthesis", "ui_grouped_results"}
TASK_STATUS_FROM_STEP_STATUS = {
    "pending": "pending",
    "running": "running",
    "completed": "completed",
    "failed": "failed",
    "aborted": "aborted",
}

DEFAULT_SUB_AGENT_PROMPT_TEMPLATE = (
    "You are acting as a specialist sub-agent inside the workflow '{{workflow_name}}'.\n\n"
    "Original user request:\n{{user_prompt}}\n\n"
    "Respond only from your own specialist perspective. Do not attempt the final synthesis. "
    "If the user sets a strict output format, exact token, or brevity constraint, preserve it exactly."
)
DEFAULT_HEAD_AGENT_PROMPT_TEMPLATE = (
    "You are the head agent coordinating the workflow '{{workflow_name}}'.\n\n"
    "Original user request:\n{{user_prompt}}\n\n"
    "Specialist sub-agent outputs:\n{{child_results}}\n\n"
    "Produce the final integrated answer, resolve conflicts where possible, and state any residual uncertainty clearly. "
    "Your response must contain only the final answer to the original user request, with no preamble or explanation unless the user explicitly asks for it. "
    "You must preserve any strict output format, exact token, or brevity constraint from the original user request exactly. "
    "If the user asks for only a token or exact string, output exactly that token or string and nothing else."
)

MAS_CONSULT_WORKFLOW_DEFINITION: dict[str, Any] = {
    "version": 1,
    "workflow_id": "mas_consult_v1",
    "name": "Head-Agent MAS Consult",
    "execution_mode": "sequential",
    "min_agents": 2,
    "max_agents": 3,
    "persist_child_conversations": True,
    "head_agent": {
        "selection_mode": "active_agent",
        "prompt_template": DEFAULT_HEAD_AGENT_PROMPT_TEMPLATE,
    },
    "nodes": [
        {
            "id": "consult_selected_sub_agents",
            "type": "child_agent",
            "description": "Send the prompt to the selected sub-agents in sequence.",
            "prompt_template": DEFAULT_SUB_AGENT_PROMPT_TEMPLATE,
        },
        {
            "id": "head_agent_synthesis",
            "type": "head_agent_synthesis",
            "description": "Have the head agent synthesize the completed child-agent outputs into one final response.",
            "prompt_template": DEFAULT_HEAD_AGENT_PROMPT_TEMPLATE,
        },
    ],
}


def normalize_workflow_definition(definition: dict[str, Any]) -> dict[str, Any]:
    normalized = deepcopy(definition)
    workflow_id = str(normalized.get("workflow_id") or "").strip()
    name = str(normalized.get("name") or "").strip()
    if not workflow_id:
        raise ValueError("workflow_id is required")
    if not name:
        raise ValueError("workflow definition name is required")

    execution_mode = str(normalized.get("execution_mode") or "sequential").strip() or "sequential"
    if execution_mode != "sequential":
        raise ValueError("only sequential workflow execution is currently supported")

    try:
        min_agents = int(normalized.get("min_agents", 2))
        max_agents = int(normalized.get("max_agents", max(min_agents, 3)))
    except (TypeError, ValueError) as exc:
        raise ValueError("min_agents and max_agents must be integers") from exc
    if min_agents < 1:
        raise ValueError("min_agents must be at least 1")
    if max_agents < min_agents:
        raise ValueError("max_agents must be greater than or equal to min_agents")

    nodes = normalized.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("workflow definition must include at least one node")

    normalized_nodes: list[dict[str, Any]] = []
    for raw_node in nodes:
        if not isinstance(raw_node, dict):
            raise ValueError("workflow nodes must be objects")
        node_id = str(raw_node.get("id") or "").strip()
        node_type = str(raw_node.get("type") or "").strip()
        description = str(raw_node.get("description") or "").strip()
        if not node_id:
            raise ValueError("workflow nodes require an id")
        if node_type not in SUPPORTED_WORKFLOW_NODE_TYPES:
            raise ValueError(f"unsupported workflow node type '{node_type}'")
        if not description:
            raise ValueError(f"workflow node '{node_id}' requires a description")
        node = {
            "id": node_id,
            "type": node_type,
            "description": description,
        }
        prompt_template = raw_node.get("prompt_template")
        if prompt_template is not None:
            node["prompt_template"] = str(prompt_template)
        normalized_nodes.append(node)

    head_agent = normalized.get("head_agent")
    if head_agent is None:
        head_agent = {
            "selection_mode": "active_agent",
            "prompt_template": DEFAULT_HEAD_AGENT_PROMPT_TEMPLATE,
        }
    if not isinstance(head_agent, dict):
        raise ValueError("head_agent must be an object when provided")
    selection_mode = str(head_agent.get("selection_mode") or "active_agent").strip() or "active_agent"
    if selection_mode not in {"active_agent", "fixed_agent"}:
        raise ValueError("head_agent.selection_mode must be active_agent or fixed_agent")
    normalized_head_agent = {
        "selection_mode": selection_mode,
        "prompt_template": str(head_agent.get("prompt_template") or DEFAULT_HEAD_AGENT_PROMPT_TEMPLATE),
    }
    fixed_agent_id = str(head_agent.get("agent_id") or "").strip() or None
    if selection_mode == "fixed_agent" and not fixed_agent_id:
        raise ValueError("head_agent.agent_id is required when selection_mode is fixed_agent")
    if fixed_agent_id:
        normalized_head_agent["agent_id"] = fixed_agent_id

    normalized["workflow_id"] = workflow_id
    normalized["name"] = name
    normalized["version"] = int(normalized.get("version", 1))
    normalized["execution_mode"] = execution_mode
    normalized["min_agents"] = min_agents
    normalized["max_agents"] = max_agents
    normalized["persist_child_conversations"] = bool(normalized.get("persist_child_conversations", True))
    normalized["head_agent"] = normalized_head_agent
    normalized["nodes"] = normalized_nodes
    return normalized


def list_workflow_definitions(session: Session) -> list[WorkflowDefinitionRecord]:
    return list(
        session.scalars(
            select(WorkflowDefinitionRecord)
            .where(WorkflowDefinitionRecord.enabled.is_(True))
            .order_by(WorkflowDefinitionRecord.workflow_id.asc())
        )
    )


def seed_workflow_definitions(session: Session) -> None:
    upsert_workflow_definition(session, MAS_CONSULT_WORKFLOW_DEFINITION)


def upsert_workflow_definition(session: Session, definition: dict[str, Any]) -> WorkflowDefinitionRecord:
    definition_payload = normalize_workflow_definition(definition)
    existing = session.scalar(
        select(WorkflowDefinitionRecord).where(
            WorkflowDefinitionRecord.workflow_id == definition_payload["workflow_id"]
        )
    )
    if existing is None:
        existing = WorkflowDefinitionRecord(
            workflow_id=definition_payload["workflow_id"],
            version=definition_payload["version"],
            name=definition_payload["name"],
            execution_mode=definition_payload["execution_mode"],
            definition_json=definition_payload,
            enabled=True,
        )
        session.add(existing)
        session.commit()
        session.refresh(existing)
        return existing

    if (
        existing.version != definition_payload["version"]
        or existing.name != definition_payload["name"]
        or existing.execution_mode != definition_payload["execution_mode"]
        or existing.definition_json != definition_payload
        or not existing.enabled
    ):
        existing.version = definition_payload["version"]
        existing.name = definition_payload["name"]
        existing.execution_mode = definition_payload["execution_mode"]
        existing.definition_json = definition_payload
        existing.enabled = True
        session.commit()
        session.refresh(existing)
    return existing


def get_workflow_definition(session: Session, workflow_id: str) -> WorkflowDefinitionRecord:
    definition = session.scalar(
        select(WorkflowDefinitionRecord).where(
            WorkflowDefinitionRecord.workflow_id == workflow_id,
            WorkflowDefinitionRecord.enabled.is_(True),
        )
    )
    if definition is None:
        raise ValueError(f"workflow '{workflow_id}' not found")
    return definition


def list_workflow_runs(
    session: Session,
    *,
    surface: str | None = None,
    workflow_id: str | None = None,
    limit: int = 20,
) -> list[WorkflowRunRecord]:
    statement = select(WorkflowRunRecord).order_by(WorkflowRunRecord.created_at.desc())
    if surface:
        statement = statement.where(WorkflowRunRecord.surface == surface)
    if workflow_id:
        statement = statement.where(WorkflowRunRecord.workflow_id == workflow_id)
    return list(session.scalars(statement.limit(limit)))


def list_workflow_steps(session: Session, run_id: str) -> list[WorkflowStepRunRecord]:
    return list(
        session.scalars(
            select(WorkflowStepRunRecord)
            .where(WorkflowStepRunRecord.run_id == run_id)
            .order_by(WorkflowStepRunRecord.sequence.asc())
        )
    )


def list_workflow_tasks(session: Session, run_id: str) -> list[WorkflowTaskRecord]:
    return list(
        session.scalars(
            select(WorkflowTaskRecord)
            .where(WorkflowTaskRecord.run_id == run_id)
            .order_by(WorkflowTaskRecord.sequence.asc(), WorkflowTaskRecord.created_at.asc())
        )
    )


def list_workflow_run_events(session: Session, run_id: str) -> list[WorkflowRunEventRecord]:
    return list(
        session.scalars(
            select(WorkflowRunEventRecord)
            .where(WorkflowRunEventRecord.run_id == run_id)
            .order_by(WorkflowRunEventRecord.sequence.asc(), WorkflowRunEventRecord.created_at.asc())
        )
    )


def _next_event_sequence(session: Session, run_id: str) -> int:
    latest = session.scalar(
        select(WorkflowRunEventRecord.sequence)
        .where(WorkflowRunEventRecord.run_id == run_id)
        .order_by(WorkflowRunEventRecord.sequence.desc())
        .limit(1)
    )
    return int(latest or 0) + 1


def append_workflow_run_event(
    session: Session,
    *,
    run_id: str,
    event_type: str,
    task_key: str | None = None,
    actor_id: str | None = None,
    metadata_json: dict[str, Any] | None = None,
) -> WorkflowRunEventRecord:
    event = WorkflowRunEventRecord(
        run_id=run_id,
        sequence=_next_event_sequence(session, run_id),
        event_type=event_type,
        task_key=task_key,
        actor_id=actor_id,
        metadata_json=metadata_json or {},
    )
    session.add(event)
    session.flush()
    return event


def replay_workflow_run_state_from_events(session: Session, run_id: str) -> dict[str, Any]:
    events = list_workflow_run_events(session, run_id)
    state: dict[str, Any] = {
        "status": "queued",
        "tasks": {},
        "last_sequence": 0,
    }
    for event in events:
        state["last_sequence"] = event.sequence
        event_type = str(event.event_type or "")
        task_key = str(event.task_key or "").strip() or None
        if event_type == "RUN_ABORTED":
            state["status"] = "aborted"
        elif event_type == "RUN_FAILED":
            state["status"] = "failed"
        elif event_type == "RUN_COMPLETED":
            state["status"] = "completed"
        elif event_type in {"TASK_CREATED", "TASK_DISPATCHED", "TASK_STARTED", "TASK_COMPLETED", "TASK_FAILED", "TASK_ABORTED"}:
            if task_key is None:
                continue
            task_state = state["tasks"].setdefault(task_key, {"status": "pending"})
            if event_type == "TASK_DISPATCHED":
                task_state["status"] = "queued"
            elif event_type == "TASK_STARTED":
                task_state["status"] = "running"
            elif event_type == "TASK_COMPLETED":
                task_state["status"] = "completed"
            elif event_type == "TASK_FAILED":
                task_state["status"] = "failed"
            elif event_type == "TASK_ABORTED":
                task_state["status"] = "aborted"
    return state


def get_workflow_run(session: Session, run_id: str) -> WorkflowRunRecord:
    run = session.get(WorkflowRunRecord, run_id)
    if run is None:
        raise ValueError(f"workflow run '{run_id}' not found")
    return run


def _normalize_agent_ids(agent_ids: list[str]) -> list[str]:
    ordered_unique_ids: list[str] = []
    seen_ids: set[str] = set()
    for agent_id in agent_ids:
        cleaned = str(agent_id or "").strip()
        if not cleaned or cleaned in seen_ids:
            continue
        seen_ids.add(cleaned)
        ordered_unique_ids.append(cleaned)
    return ordered_unique_ids


def _apply_run_rollup(run: WorkflowRunRecord, steps: list[WorkflowStepRunRecord]) -> None:
    total_steps = len(steps)
    completed_steps = sum(1 for step in steps if step.status == "completed")
    failed_steps = sum(1 for step in steps if step.status == "failed")
    aborted_steps = sum(1 for step in steps if step.status == "aborted")
    terminal_steps = completed_steps + failed_steps + aborted_steps
    running_step = next((step for step in steps if step.status == "running"), None)
    pending_step = next((step for step in steps if step.status == "pending"), None)

    if total_steps == 0:
        run.status = "failed"
        run.current_step = "no_steps"
        run.progress = 1.0
        run.error_message = run.error_message or "Workflow run has no steps."
        run.completed_at = run.completed_at or utc_now()
    elif terminal_steps == total_steps:
        if failed_steps or aborted_steps:
            run.status = "completed_with_errors" if completed_steps else ("aborted" if aborted_steps else "failed")
        else:
            run.status = "completed"
        run.current_step = "completed"
        run.progress = 1.0
        run.completed_at = run.completed_at or utc_now()
    elif running_step is not None:
        run.status = "running"
        run.current_step = running_step.agent_name or running_step.node_id
        run.progress = terminal_steps / total_steps
        run.completed_at = None
    elif terminal_steps > 0 or pending_step is not None:
        run.status = "running" if terminal_steps > 0 else "queued"
        run.current_step = pending_step.agent_name or pending_step.node_id if pending_step is not None else "queued"
        run.progress = terminal_steps / total_steps
        run.completed_at = None
    else:
        run.status = "queued"
        run.current_step = "queued"
        run.progress = 0.0
        run.completed_at = None

    if total_steps > 0 and any(step.status != "pending" for step in steps):
        run.started_at = run.started_at or utc_now()

    run.result_json = {
        **(run.result_json or {}),
        "step_counts": {
            "total": total_steps,
            "completed": completed_steps,
            "failed": failed_steps,
            "aborted": aborted_steps,
            "pending": max(total_steps - terminal_steps - (1 if running_step is not None else 0), 0),
            "running": 1 if running_step is not None else 0,
        },
    }


def _task_key_for_step(step: WorkflowStepRunRecord) -> str:
    return f"{step.node_id}:{step.sequence}"


def _ensure_workflow_tasks_for_run(session: Session, run_id: str) -> None:
    existing_by_step_id = {
        str(task.step_run_id): task
        for task in list_workflow_tasks(session, run_id)
        if task.step_run_id is not None
    }
    for step in list_workflow_steps(session, run_id):
        task = existing_by_step_id.get(step.id)
        if task is None:
            task = WorkflowTaskRecord(
                run_id=run_id,
                task_key=_task_key_for_step(step),
                title=f"{step.agent_name or step.node_id}: {step.node_type}",
                task_kind="head_synthesis" if step.node_type == "head_agent_synthesis" else "child_agent",
                status=TASK_STATUS_FROM_STEP_STATUS.get(step.status, "pending"),
                sequence=step.sequence,
                assigned_agent_id=step.agent_id,
                assigned_agent_name=step.agent_name,
                step_run_id=step.id,
                metadata_json={
                    "node_id": step.node_id,
                    "node_type": step.node_type,
                    "step_role": str((step.metadata_json or {}).get("step_role") or ""),
                },
                started_at=step.started_at,
                completed_at=step.completed_at,
            )
            session.add(task)
            append_workflow_run_event(
                session,
                run_id=run_id,
                event_type="TASK_CREATED",
                task_key=task.task_key,
                actor_id=step.agent_id,
                metadata_json={
                    "step_id": step.id,
                    "node_type": step.node_type,
                    "agent_name": step.agent_name,
                },
            )
            continue
        next_status = TASK_STATUS_FROM_STEP_STATUS.get(step.status, "pending")
        if task.status != next_status:
            task.status = next_status
        task.started_at = step.started_at
        task.completed_at = step.completed_at
        task.assigned_agent_id = step.agent_id
        task.assigned_agent_name = step.agent_name


def _sync_task_from_step(
    session: Session,
    *,
    run_id: str,
    step: WorkflowStepRunRecord,
    event_type: str | None = None,
    metadata_json: dict[str, Any] | None = None,
) -> None:
    task = session.scalar(
        select(WorkflowTaskRecord).where(
            WorkflowTaskRecord.run_id == run_id,
            WorkflowTaskRecord.step_run_id == step.id,
        )
    )
    if task is None:
        _ensure_workflow_tasks_for_run(session, run_id)
        task = session.scalar(
            select(WorkflowTaskRecord).where(
                WorkflowTaskRecord.run_id == run_id,
                WorkflowTaskRecord.step_run_id == step.id,
            )
        )
    if task is None:
        return
    task.status = TASK_STATUS_FROM_STEP_STATUS.get(step.status, "pending")
    task.started_at = step.started_at
    task.completed_at = step.completed_at
    task.assigned_agent_id = step.agent_id
    task.assigned_agent_name = step.agent_name
    if event_type:
        append_workflow_run_event(
            session,
            run_id=run_id,
            event_type=event_type,
            task_key=task.task_key,
            actor_id=step.agent_id,
            metadata_json=metadata_json or {},
        )


def create_workflow_run(
    session: Session,
    *,
    workflow_id: str,
    surface: str,
    prompt: str,
    agent_ids: list[str],
    parent_conversation_id: str | None = None,
    result_json: dict[str, Any] | None = None,
    head_agent_id: str | None = None,
) -> WorkflowRunRecord:
    definition = get_workflow_definition(session, workflow_id)
    definition_payload = normalize_workflow_definition(definition.definition_json or {})
    normalized_agent_ids = _normalize_agent_ids(agent_ids)
    min_agents = int(definition_payload.get("min_agents", 1))
    max_agents = int(definition_payload.get("max_agents", max(min_agents, len(normalized_agent_ids) or 1)))
    if len(normalized_agent_ids) < min_agents:
        raise ValueError(f"workflow '{workflow_id}' requires at least {min_agents} agents")
    if len(normalized_agent_ids) > max_agents:
        raise ValueError(f"workflow '{workflow_id}' allows at most {max_agents} agents")

    agents = list(
        session.scalars(
            select(AgentProfileRecord).where(
                AgentProfileRecord.id.in_(normalized_agent_ids),
                AgentProfileRecord.enabled.is_(True),
            )
        )
    )
    agents_by_id = {agent.id: agent for agent in agents}
    missing_ids = [agent_id for agent_id in normalized_agent_ids if agent_id not in agents_by_id]
    if missing_ids:
        raise ValueError(f"unknown or disabled agent ids: {', '.join(missing_ids)}")

    resolved_head_agent_id = str(head_agent_id or "").strip() or None
    head_agent_config = dict(definition_payload.get("head_agent") or {})
    if resolved_head_agent_id is None and head_agent_config.get("selection_mode") == "fixed_agent":
        resolved_head_agent_id = str(head_agent_config.get("agent_id") or "").strip() or None
    head_agent_record = None
    if resolved_head_agent_id:
        head_agent_record = session.get(AgentProfileRecord, resolved_head_agent_id)
        if head_agent_record is None or not head_agent_record.enabled:
            raise ValueError(f"unknown or disabled head agent id: {resolved_head_agent_id}")

    run = WorkflowRunRecord(
        workflow_definition_id=definition.id,
        workflow_id=definition.workflow_id,
        surface=surface,
        execution_mode=definition.execution_mode,
        status="queued",
        current_step="queued",
        progress=0.0,
        prompt=prompt.strip(),
        requested_agent_ids_json=normalized_agent_ids,
        parent_conversation_id=parent_conversation_id,
        result_json={
            **(result_json or {}),
            "workflow": {
                "name": definition_payload["name"],
                "head_agent_id": resolved_head_agent_id,
                "head_agent_name": head_agent_record.name if head_agent_record is not None else None,
            },
        },
    )
    session.add(run)
    session.flush()
    append_workflow_run_event(
        session,
        run_id=run.id,
        event_type="RUN_CREATED",
        actor_id=resolved_head_agent_id,
        metadata_json={
            "workflow_id": definition.workflow_id,
            "surface": surface,
            "requested_agent_ids": normalized_agent_ids,
        },
    )
    append_workflow_run_event(
        session,
        run_id=run.id,
        event_type="PLAN_GRAPH_CREATED",
        actor_id=resolved_head_agent_id,
        metadata_json={
            "workflow_name": definition_payload["name"],
            "node_count": len(definition_payload["nodes"]),
        },
    )

    sequence = 1
    for node in definition_payload["nodes"]:
        if node["type"] == "child_agent":
            for agent_id in normalized_agent_ids:
                agent = agents_by_id[agent_id]
                session.add(
                    WorkflowStepRunRecord(
                        run_id=run.id,
                        sequence=sequence,
                        node_id=node["id"],
                        node_type=node["type"],
                        status="pending",
                        agent_id=agent.id,
                        agent_name=agent.name,
                        citations_json=[],
                        metadata_json={
                            "description": node["description"],
                            "prompt_template": node.get("prompt_template") or DEFAULT_SUB_AGENT_PROMPT_TEMPLATE,
                            "step_role": "sub_agent",
                        },
                    )
                )
                sequence += 1
        elif node["type"] == "head_agent_synthesis" and head_agent_record is not None:
            session.add(
                WorkflowStepRunRecord(
                    run_id=run.id,
                    sequence=sequence,
                    node_id=node["id"],
                    node_type=node["type"],
                    status="pending",
                    agent_id=head_agent_record.id,
                    agent_name=head_agent_record.name,
                    citations_json=[],
                    metadata_json={
                        "description": node["description"],
                        "prompt_template": node.get("prompt_template")
                        or head_agent_config.get("prompt_template")
                        or DEFAULT_HEAD_AGENT_PROMPT_TEMPLATE,
                        "step_role": "head_agent",
                    },
                )
            )
            sequence += 1

    session.flush()
    _ensure_workflow_tasks_for_run(session, run.id)
    steps = list_workflow_steps(session, run.id)
    _apply_run_rollup(run, steps)
    session.commit()
    session.refresh(run)
    return run


def update_workflow_run(
    session: Session,
    *,
    run_id: str,
    status: str | None = None,
    error_message: str | None = None,
    result_json: dict[str, Any] | None = None,
) -> WorkflowRunRecord:
    run = get_workflow_run(session, run_id)
    prior_status = run.status
    if status is not None:
        run.status = status
        run.current_step = "completed" if status in RUN_TERMINAL_STATUSES else run.current_step
        if status in RUN_TERMINAL_STATUSES:
            run.completed_at = run.completed_at or utc_now()
            if status == "aborted":
                for step in list_workflow_steps(session, run.id):
                    if step.status not in STEP_TERMINAL_STATUSES:
                        step.status = "aborted"
                        step.completed_at = step.completed_at or utc_now()
                        _sync_task_from_step(
                            session,
                            run_id=run.id,
                            step=step,
                            event_type="TASK_ABORTED",
                            metadata_json={"reason": "run_aborted"},
                        )
        else:
            run.started_at = run.started_at or utc_now()
    if error_message is not None:
        run.error_message = error_message
    if result_json is not None:
        run.result_json = {**(run.result_json or {}), **result_json}

    session.flush()
    _apply_run_rollup(run, list_workflow_steps(session, run.id))
    if status is not None and status != prior_status:
        terminal_event = None
        if status == "completed":
            terminal_event = "RUN_COMPLETED"
        elif status in {"completed_with_errors", "failed"}:
            terminal_event = "RUN_FAILED"
        elif status == "aborted":
            terminal_event = "RUN_ABORTED"
        if terminal_event is not None:
            append_workflow_run_event(
                session,
                run_id=run.id,
                event_type=terminal_event,
                actor_id=str((run.result_json or {}).get("workflow", {}).get("head_agent_id") or "") or None,
                metadata_json={"status": status, "error_message": run.error_message},
            )
    if status is not None and status in {"aborted", "failed"}:
        run.status = status
        run.completed_at = run.completed_at or utc_now()

    session.commit()
    session.refresh(run)
    return run


def update_workflow_step_run(
    session: Session,
    *,
    run_id: str,
    step_id: str,
    status: str | None = None,
    conversation_id: str | None = None,
    output_text: str | None = None,
    citations: list[dict] | None = None,
    error_message: str | None = None,
    metadata_json: dict[str, Any] | None = None,
) -> WorkflowRunRecord:
    run = get_workflow_run(session, run_id)
    step = session.get(WorkflowStepRunRecord, step_id)
    if step is None or step.run_id != run.id:
        raise ValueError(f"workflow step '{step_id}' not found for run '{run_id}'")

    previous_status = step.status
    if status is not None:
        step.status = status
        if status == "running":
            step.started_at = step.started_at or utc_now()
        elif status in STEP_TERMINAL_STATUSES:
            step.started_at = step.started_at or utc_now()
            step.completed_at = step.completed_at or utc_now()
    if conversation_id is not None:
        step.conversation_id = conversation_id
    if output_text is not None:
        step.output_text = output_text
    if citations is not None:
        step.citations_json = citations
    if error_message is not None:
        step.error_message = error_message
    if metadata_json is not None:
        step.metadata_json = metadata_json

    if status is not None and status != previous_status:
        event_type = None
        if status == "running":
            event_type = "TASK_STARTED"
        elif status == "completed":
            event_type = "TASK_COMPLETED"
        elif status == "failed":
            event_type = "TASK_FAILED"
        elif status == "aborted":
            event_type = "TASK_ABORTED"
        _sync_task_from_step(
            session,
            run_id=run.id,
            step=step,
            event_type=event_type,
            metadata_json={
                "step_id": step.id,
                "node_type": step.node_type,
                "conversation_id": step.conversation_id,
                "error_message": step.error_message,
            },
        )

    session.flush()
    _apply_run_rollup(run, list_workflow_steps(session, run.id))
    session.commit()
    session.refresh(run)
    return run
