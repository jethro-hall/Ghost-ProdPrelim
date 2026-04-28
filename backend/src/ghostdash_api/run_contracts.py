from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

RunEventType = Literal[
    "RUN_CREATED",
    "PLAN_GRAPH_CREATED",
    "TASK_CREATED",
    "TASK_DISPATCHED",
    "TASK_STARTED",
    "TASK_COMPLETED",
    "TASK_FAILED",
    "TASK_ABORTED",
    "TOOL_INVOCATION_STARTED",
    "TOOL_INVOCATION_COMPLETED",
    "TOOL_INVOCATION_BLOCKED",
    "APPROVAL_REQUIRED",
    "APPROVAL_GRANTED",
    "APPROVAL_REJECTED",
    "RUN_COMPLETED",
    "RUN_FAILED",
    "RUN_ABORTED",
    "BP_AUDIT_EVALUATED",
    "BP_AUDIT_PASSED",
    "BP_AUDIT_FAILED",
]

TaskStatus = Literal["pending", "queued", "running", "completed", "failed", "aborted"]
TaskKind = Literal["child_agent", "head_synthesis", "tool", "approval", "memory"]
RiskClass = Literal["read", "write", "destructive"]


class RunStartContract(BaseModel):
    run_id: str
    workflow_id: str
    surface: str
    actor_id: str | None = None
    tenant_id: str | None = None
    objective: str = Field(min_length=1)
    constraints: dict[str, Any] = Field(default_factory=dict)
    selected_head_agent_id: str | None = None
    policy_snapshot_id: str | None = None
    created_at: datetime


class PlanTaskContract(BaseModel):
    task_id: str
    run_id: str
    title: str = Field(min_length=1, max_length=256)
    task_kind: TaskKind
    status: TaskStatus = "pending"
    sequence: int = Field(ge=1)
    depends_on_task_ids: list[str] = Field(default_factory=list)
    assigned_agent_id: str | None = None
    assigned_agent_name: str | None = None
    metadata_json: dict[str, Any] = Field(default_factory=dict)


class PlanGraphContract(BaseModel):
    run_id: str
    generated_at: datetime
    source: Literal["workflow_definition", "dynamic_planner"] = "workflow_definition"
    tasks: list[PlanTaskContract] = Field(default_factory=list)


class TaskDispatchContract(BaseModel):
    run_id: str
    task_id: str
    worker_type: str = Field(min_length=1, max_length=64)
    input_payload_hash: str | None = None
    timeout_seconds: float = Field(default=300.0, gt=0)
    retry_budget: int = Field(default=1, ge=0, le=10)
    policy_context: dict[str, Any] = Field(default_factory=dict)
    lease_id: str | None = None
    dispatched_at: datetime


class ToolInvocationContract(BaseModel):
    run_id: str
    task_id: str | None = None
    tool_id: str = Field(min_length=1, max_length=64)
    operation: str = Field(min_length=1, max_length=128)
    risk_class: RiskClass = "read"
    requires_approval: bool = False
    approval_token: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    started_at: datetime


class RunEventContract(BaseModel):
    run_id: str
    sequence: int = Field(ge=1)
    event_type: RunEventType
    task_id: str | None = None
    actor_id: str | None = None
    metadata_json: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime

