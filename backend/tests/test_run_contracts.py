from __future__ import annotations

from datetime import UTC, datetime

from ghostdash_api.run_contracts import (
    PlanGraphContract,
    PlanTaskContract,
    RunEventContract,
    RunStartContract,
    TaskDispatchContract,
    ToolInvocationContract,
)


def test_run_start_contract_accepts_minimum_payload() -> None:
    contract = RunStartContract(
        run_id="run-1",
        workflow_id="mas_consult_v1",
        surface="ghost_chatui",
        objective="Produce a board-ready multi-agent answer.",
        created_at=datetime.now(UTC),
    )
    assert contract.run_id == "run-1"
    assert contract.policy_snapshot_id is None


def test_plan_graph_contract_requires_task_identity() -> None:
    task = PlanTaskContract(
        task_id="task-1",
        run_id="run-1",
        title="Finance specialist extraction",
        task_kind="child_agent",
        sequence=1,
    )
    graph = PlanGraphContract(run_id="run-1", generated_at=datetime.now(UTC), tasks=[task])
    assert graph.tasks[0].task_kind == "child_agent"
    assert graph.tasks[0].status == "pending"


def test_dispatch_and_tool_contracts_capture_governance_fields() -> None:
    dispatch = TaskDispatchContract(
        run_id="run-1",
        task_id="task-1",
        worker_type="agent_worker",
        dispatched_at=datetime.now(UTC),
        retry_budget=2,
    )
    tool = ToolInvocationContract(
        run_id="run-1",
        task_id="task-1",
        tool_id="odoo_primary",
        operation="odoo.finance.shopify.monthly_roi",
        risk_class="read",
        requires_approval=False,
        started_at=datetime.now(UTC),
    )
    assert dispatch.retry_budget == 2
    assert tool.tool_id == "odoo_primary"


def test_run_event_contract_preserves_sequence() -> None:
    event = RunEventContract(
        run_id="run-1",
        sequence=3,
        event_type="TASK_COMPLETED",
        task_id="task-1",
        created_at=datetime.now(UTC),
    )
    assert event.sequence == 3
    assert event.event_type == "TASK_COMPLETED"


def test_run_event_contract_accepts_bp_audit_events() -> None:
    event = RunEventContract(
        run_id="run-1",
        sequence=4,
        event_type="BP_AUDIT_EVALUATED",
        task_id="task-2",
        created_at=datetime.now(UTC),
    )
    assert event.event_type == "BP_AUDIT_EVALUATED"

