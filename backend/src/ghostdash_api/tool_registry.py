from __future__ import annotations

from copy import deepcopy
from typing import Any
from uuid import uuid4

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import (
    AgentProfileRecord,
    OdooEvidenceMirrorRecord,
    RuntimeProfileRecord,
    ToolExecutionAuditRecord,
    ToolRegistryRecord,
)
from .odoo_connector import (
    ODOO_GATEWAY,
    ODOO_PROVIDER,
    ODOO_SAFE_OPERATIONS,
    ODOO_TOOL_ID,
    OdooConnectorError,
    config_from_dict,
    default_odoo_config,
    execute_odoo_operation,
    mask_identity,
    missing_odoo_config,
    test_odoo_connection,
)
from .runtime_profiles import (
    build_unique_runtime_profile_name,
    clone_runtime_profile,
    get_default_runtime_profile,
    normalize_tool_policy_config,
)
from .schemas import (
    ToolCatalogEntryView,
    ToolDetailView,
    ToolExecuteResponse,
    ToolPolicyView,
    ToolReadinessSummary,
    ToolSettingsView,
    ToolTestResponse,
)

RISK_CLASS_BY_OPERATION: dict[str, str] = {
    "odoo.rpc.execute_kw": "destructive",
}

# Public discovery of the legacy odoo_primary tool is retired.
LEGACY_ODOO_PUBLIC_EXPOSURE = False
CONSUMER_CUSTOMER_CATEGORY = "consumer_customer"
BUSINESS_FINANCE_TOOL_IDS = {ODOO_TOOL_ID}


def _default_odoo_record() -> ToolRegistryRecord:
    return ToolRegistryRecord(
        id=ODOO_TOOL_ID,
        provider=ODOO_PROVIDER,
        name="Odoo ERP",
        gateway=ODOO_GATEWAY,
        description="Governed Odoo ERP access routed through the Ghost stack control plane.",
        status="unknown",
        active=False,
        config_json=default_odoo_config(),
    )


def get_or_create_odoo_registry(session: Session) -> ToolRegistryRecord:
    record = session.get(ToolRegistryRecord, ODOO_TOOL_ID)
    if record is not None:
        return record
    record = _default_odoo_record()
    session.add(record)
    session.commit()
    session.refresh(record)
    return record


def _merge_odoo_config(existing: dict[str, Any] | None, updates: dict[str, Any] | None) -> dict[str, Any]:
    merged = default_odoo_config()
    merged.update(dict(existing or {}))
    incoming = dict(updates or {})
    for key in ("base_url", "database", "username"):
        if key not in incoming:
            continue
        value = incoming.get(key)
        if value is None:
            continue
        normalized = str(value).strip()
        if normalized:
            merged[key] = normalized
    password = incoming.get("password")
    if password is not None:
        normalized_password = str(password).strip()
        if normalized_password:
            merged["password"] = normalized_password
    timeout_ms = incoming.get("timeout_ms")
    if timeout_ms is not None:
        merged["timeout_ms"] = int(timeout_ms)
    merged["auth_source"] = "direct_credentials"
    if "read_only" in incoming:
        merged["read_only"] = bool(incoming.get("read_only"))
    return merged


def _build_tool_settings_view(record: ToolRegistryRecord) -> ToolSettingsView:
    config = default_odoo_config()
    config.update(dict(record.config_json or {}))
    return ToolSettingsView(
        base_url=str(config.get("base_url") or "").strip() or None,
        database=str(config.get("database") or "").strip() or None,
        username_hint=mask_identity(config.get("username")),
        has_password=bool(str(config.get("password") or "").strip()),
        auth_source="direct_credentials",
        read_only=bool(config.get("read_only", True)),
        timeout_ms=int(config.get("timeout_ms") or default_odoo_config()["timeout_ms"]),
        health_path=str(config.get("health_path") or default_odoo_config()["health_path"]),
        execute_path=str(config.get("execute_path") or default_odoo_config()["execute_path"]),
        missing_config=missing_odoo_config(config),
    )


def _build_tool_catalog_entry(record: ToolRegistryRecord) -> ToolCatalogEntryView:
    settings = _build_tool_settings_view(record)
    return ToolCatalogEntryView(
        id=record.id,
        provider=record.provider,
        name=record.name,
        gateway=record.gateway,
        description=record.description,
        status=record.status,
        active=bool(record.active),
        configured=len(settings.missing_config) == 0,
        read_only=settings.read_only,
        session_toggleable=True,
    )


def build_tool_detail(record: ToolRegistryRecord) -> ToolDetailView:
    entry = _build_tool_catalog_entry(record)
    return ToolDetailView(
        **entry.model_dump(),
        settings=_build_tool_settings_view(record),
        safe_operations=list(ODOO_SAFE_OPERATIONS),
    )


def list_tool_catalog(session: Session) -> list[ToolCatalogEntryView]:
    if not LEGACY_ODOO_PUBLIC_EXPOSURE:
        return []
    record = get_or_create_odoo_registry(session)
    return [_build_tool_catalog_entry(record)]


def get_tool_detail(session: Session, tool_id: str) -> ToolDetailView:
    if tool_id != ODOO_TOOL_ID:
        raise ValueError(f"Unsupported tool id: {tool_id}")
    return build_tool_detail(get_or_create_odoo_registry(session))


def update_tool_settings(session: Session, tool_id: str, payload: dict[str, Any]) -> ToolDetailView:
    if tool_id != ODOO_TOOL_ID:
        raise ValueError(f"Unsupported tool id: {tool_id}")
    record = get_or_create_odoo_registry(session)
    next_config = _merge_odoo_config(record.config_json, payload)
    if next_config != dict(record.config_json or {}):
        record.config_json = next_config
        record.status = "unknown"
    session.add(record)
    session.commit()
    session.refresh(record)
    return build_tool_detail(record)


def set_tool_activation(session: Session, tool_id: str, active: bool) -> ToolCatalogEntryView:
    if tool_id != ODOO_TOOL_ID:
        raise ValueError(f"Unsupported tool id: {tool_id}")
    record = get_or_create_odoo_registry(session)
    record.active = bool(active)
    session.add(record)
    session.commit()
    session.refresh(record)
    return _build_tool_catalog_entry(record)


def run_tool_test(session: Session, tool_id: str) -> ToolTestResponse:
    if tool_id != ODOO_TOOL_ID:
        raise ValueError(f"Unsupported tool id: {tool_id}")
    record = get_or_create_odoo_registry(session)
    config = default_odoo_config()
    config.update(dict(record.config_json or {}))
    missing = missing_odoo_config(config)
    if missing:
        record.status = "unhealthy"
        session.add(record)
        session.commit()
        session.refresh(record)
        return ToolTestResponse(
            success=False,
            message=f"Odoo configuration incomplete: {', '.join(missing)}.",
            data={"missing_config": missing, "safe_operations": list(ODOO_SAFE_OPERATIONS)},
        )
    try:
        result = test_odoo_connection(config_from_dict(config))
        record.status = "healthy"
        session.add(record)
        session.commit()
        session.refresh(record)
        return ToolTestResponse(**result)
    except (OdooConnectorError, httpx.HTTPError, ValueError) as exc:
        record.status = "unhealthy"
        session.add(record)
        session.commit()
        session.refresh(record)
        return ToolTestResponse(
            success=False,
            message=str(exc),
            data={"safe_operations": list(ODOO_SAFE_OPERATIONS)},
        )


def execute_tool_operation(
    session: Session,
    tool_id: str,
    *,
    operation: str,
    payload: dict[str, Any] | None = None,
    dry_run: bool = False,
    approval_token: str | None = None,
    actor_agent_id: str | None = None,
    surface: str = "control_api",
) -> ToolExecuteResponse:
    if tool_id != ODOO_TOOL_ID:
        raise ValueError(f"Unsupported tool id: {tool_id}")
    record = get_or_create_odoo_registry(session)
    policy_decision_id = str(uuid4())
    risk_class = _resolve_risk_class(operation)
    requires_approval = risk_class in {"write", "destructive"}
    approved = bool(str(approval_token or "").strip()) if requires_approval else True
    if dry_run:
        approved = False
    config = default_odoo_config()
    config.update(dict(record.config_json or {}))
    missing = missing_odoo_config(config)
    if missing:
        response = ToolExecuteResponse(
            success=False,
            message=f"Odoo configuration incomplete: {', '.join(missing)}.",
            operation=operation,
            risk_class=risk_class,  # type: ignore[arg-type]
            requires_approval=requires_approval,
            approved=approved,
            policy_decision_id=policy_decision_id,
            data={"missing_config": missing},
        )
        _write_tool_audit_entry(
            session,
            tool_id=tool_id,
            operation=operation,
            risk_class=risk_class,
            requires_approval=requires_approval,
            approved=approved,
            approval_token=approval_token,
            actor_agent_id=actor_agent_id,
            surface=surface,
            status="blocked",
            policy_decision_id=policy_decision_id,
            payload=payload,
            response=response.model_dump(),
        )
        return response
    if dry_run:
        response = ToolExecuteResponse(
            success=True,
            message="Dry-run policy check passed. Execution skipped.",
            operation=operation,
            risk_class=risk_class,  # type: ignore[arg-type]
            requires_approval=requires_approval,
            approved=approved,
            policy_decision_id=policy_decision_id,
            data={"dry_run": True},
        )
        _write_tool_audit_entry(
            session,
            tool_id=tool_id,
            operation=operation,
            risk_class=risk_class,
            requires_approval=requires_approval,
            approved=approved,
            approval_token=approval_token,
            actor_agent_id=actor_agent_id,
            surface=surface,
            status="dry_run",
            policy_decision_id=policy_decision_id,
            payload=payload,
            response=response.model_dump(),
        )
        return response
    if requires_approval and not approved:
        response = ToolExecuteResponse(
            success=False,
            message="Operation requires approval token.",
            operation=operation,
            risk_class=risk_class,  # type: ignore[arg-type]
            requires_approval=True,
            approved=False,
            policy_decision_id=policy_decision_id,
            data={"blocked_reasons": ["missing_approval_token"]},
        )
        _write_tool_audit_entry(
            session,
            tool_id=tool_id,
            operation=operation,
            risk_class=risk_class,
            requires_approval=True,
            approved=False,
            approval_token=approval_token,
            actor_agent_id=actor_agent_id,
            surface=surface,
            status="blocked",
            policy_decision_id=policy_decision_id,
            payload=payload,
            response=response.model_dump(),
        )
        return response
    try:
        result = execute_odoo_operation(config_from_dict(config), operation=operation, payload=payload)
        result_data = dict(result.get("data") or {}) if isinstance(result.get("data"), dict) else {}
        result_data.setdefault("evidence_source_mode", "live_odoo")
        result_data.setdefault("evidence_cache_eligible", True)
        result["data"] = result_data
        response = ToolExecuteResponse(
            **result,
            risk_class=risk_class,  # type: ignore[arg-type]
            requires_approval=requires_approval,
            approved=approved,
            policy_decision_id=policy_decision_id,
        )
        _write_tool_audit_entry(
            session,
            tool_id=tool_id,
            operation=operation,
            risk_class=risk_class,
            requires_approval=requires_approval,
            approved=approved,
            approval_token=approval_token,
            actor_agent_id=actor_agent_id,
            surface=surface,
            status="executed" if response.success else "failed",
            policy_decision_id=policy_decision_id,
            payload=payload,
            response=response.model_dump(),
        )
        return response
    except (OdooConnectorError, httpx.HTTPError, ValueError) as exc:
        response = ToolExecuteResponse(
            success=False,
            message=str(exc),
            operation=operation,
            risk_class=risk_class,  # type: ignore[arg-type]
            requires_approval=requires_approval,
            approved=approved,
            policy_decision_id=policy_decision_id,
            data={},
        )
        _write_tool_audit_entry(
            session,
            tool_id=tool_id,
            operation=operation,
            risk_class=risk_class,
            requires_approval=requires_approval,
            approved=approved,
            approval_token=approval_token,
            actor_agent_id=actor_agent_id,
            surface=surface,
            status="failed",
            policy_decision_id=policy_decision_id,
            payload=payload,
            response=response.model_dump(),
        )
        return response


def _get_agent_record(session: Session, agent_id: str) -> AgentProfileRecord:
    agent = session.get(AgentProfileRecord, agent_id)
    if agent is None:
        raise ValueError(f"Agent {agent_id} not found")
    return agent


def _get_agent_runtime_profile(session: Session, agent: AgentProfileRecord) -> RuntimeProfileRecord:
    if agent.runtime_profile_id:
        profile = session.get(RuntimeProfileRecord, agent.runtime_profile_id)
        if profile is not None:
            if normalize_tool_policy_config(profile.tool_policy_config_json or {}) != (profile.tool_policy_config_json or {}):
                profile.tool_policy_config_json = normalize_tool_policy_config(profile.tool_policy_config_json or {})
                session.add(profile)
                session.commit()
                session.refresh(profile)
            return profile
    default_profile = get_default_runtime_profile(session)
    if agent.runtime_profile_id != default_profile.id:
        agent.runtime_profile_id = default_profile.id
        session.add(agent)
        session.commit()
        session.refresh(agent)
    return default_profile


def _allowed_catalog_tool_ids(profile: RuntimeProfileRecord) -> list[str]:
    tool_policy = normalize_tool_policy_config(profile.tool_policy_config_json or {})
    guardrails = dict(profile.guardrails_config_json or {})
    category = str(guardrails.get("agent_category") or "").strip().lower()
    allowed: list[str] = []
    for tool in list(tool_policy.get("tools") or []):
        tool_id = str(tool.get("id") or "").strip()
        if not tool_id:
            continue
        if category == CONSUMER_CUSTOMER_CATEGORY and tool_id in BUSINESS_FINANCE_TOOL_IDS:
            continue
        if bool(tool.get("enabled", False)):
            allowed.append(tool_id)
    return allowed


def get_agent_tool_policy(session: Session, agent_id: str) -> ToolPolicyView:
    agent = _get_agent_record(session, agent_id)
    profile = _get_agent_runtime_profile(session, agent)
    return ToolPolicyView(agent_id=agent.id, allowed_tool_ids=_allowed_catalog_tool_ids(profile))


def _clone_runtime_profile_for_agent(
    session: Session,
    *,
    agent: AgentProfileRecord,
    source_profile: RuntimeProfileRecord,
) -> RuntimeProfileRecord:
    clone = clone_runtime_profile(
        session,
        source_profile,
        name=build_unique_runtime_profile_name(
            session,
            f"{source_profile.name} {agent.name}".strip(),
            ignore_profile_id=source_profile.id,
        ),
    )
    agent.runtime_profile_id = clone.id
    session.add(agent)
    session.flush()
    return clone


def update_agent_tool_policy(session: Session, agent_id: str, allowed_tool_ids: list[str]) -> ToolPolicyView:
    agent = _get_agent_record(session, agent_id)
    profile = _get_agent_runtime_profile(session, agent)
    profile_usage_count = session.scalar(
        select(func.count(AgentProfileRecord.id)).where(AgentProfileRecord.runtime_profile_id == profile.id)
    ) or 0
    if profile_usage_count > 1:
        profile = _clone_runtime_profile_for_agent(session, agent=agent, source_profile=profile)

    guardrails = dict(profile.guardrails_config_json or {})
    category = str(guardrails.get("agent_category") or "").strip().lower()
    valid_ids = {
        str(tool.get("id") or "").strip()
        for tool in list((profile.tool_policy_config_json or {}).get("tools") or [])
        if str(tool.get("id") or "").strip()
    }
    blocked_ids = BUSINESS_FINANCE_TOOL_IDS if category == CONSUMER_CUSTOMER_CATEGORY else set()
    allowed_set = {tool_id for tool_id in allowed_tool_ids if tool_id in valid_ids and tool_id not in blocked_ids}
    next_policy = normalize_tool_policy_config(deepcopy(profile.tool_policy_config_json or {}))
    next_tools: list[dict[str, Any]] = []
    for tool in list(next_policy.get("tools") or []):
        tool_id = str(tool.get("id") or "").strip()
        if tool_id == ODOO_TOOL_ID:
            updated = dict(tool)
            updated["enabled"] = tool_id in allowed_set
            next_tools.append(updated)
            continue
        next_tools.append(dict(tool))
    next_policy["tools"] = next_tools
    profile.tool_policy_config_json = next_policy
    session.add(profile)
    session.commit()
    session.refresh(profile)
    session.refresh(agent)
    return ToolPolicyView(agent_id=agent.id, allowed_tool_ids=_allowed_catalog_tool_ids(profile))


def build_tool_readiness_summary(
    session: Session,
    *,
    agent_id: str | None,
    tool_overrides: dict[str, bool] | None = None,
) -> list[ToolReadinessSummary]:
    if not LEGACY_ODOO_PUBLIC_EXPOSURE:
        return []
    record = get_or_create_odoo_registry(session)
    allowed_tool_ids: set[str] = set()
    if agent_id:
        try:
            allowed_tool_ids = set(get_agent_tool_policy(session, agent_id).allowed_tool_ids)
        except ValueError:
            allowed_tool_ids = set()
    session_enabled = bool(dict(tool_overrides or {}).get(ODOO_TOOL_ID, True))
    settings = _build_tool_settings_view(record)
    blocked_reasons: list[str] = []
    if ODOO_TOOL_ID not in allowed_tool_ids:
        blocked_reasons.append("Not allowed for this agent")
    if not bool(record.active):
        blocked_reasons.append("Globally inactive")
    if settings.missing_config:
        blocked_reasons.append(f"Missing configuration: {', '.join(settings.missing_config)}")
    if str(record.status or "unknown") != "healthy":
        blocked_reasons.append("Tool health degraded")
    if not session_enabled:
        blocked_reasons.append("Turned off for this session")

    status = "ready"
    if blocked_reasons:
        if ODOO_TOOL_ID not in allowed_tool_ids:
            status = "disabled_for_agent"
        elif not session_enabled:
            status = "disabled_for_session"
        elif settings.missing_config:
            status = "missing_config"
        elif not bool(record.active):
            status = "disabled_globally"
        else:
            status = "unhealthy"

    return [
        ToolReadinessSummary(
            id=record.id,
            status=status,
            blocked_reasons=blocked_reasons,
            active=bool(record.active),
            enabled_for_agent=ODOO_TOOL_ID in allowed_tool_ids,
            session_enabled=session_enabled,
            health=str(record.status or "unknown"),
        )
    ]


def _consumer_chat_operation_allowed(operation: str, payload: dict[str, Any] | None = None) -> tuple[bool, str | None]:
    normalized_payload = dict(payload or {})
    generic_search_read_models = {
        "res.company",
        "account.move",
        "account.move.line",
        "product.template",
        "product.product",
    }
    generic_read_group_models = {
        "res.company",
        "account.move",
        "account.move.line",
        "sale.order",
        "sale.order.line",
        "product.template",
        "product.product",
    }
    if operation in {
        "odoo.meta.current_user",
        "odoo.meta.model_catalog",
        "odoo.products.search_read",
        "odoo.customers.search_read",
        "odoo.sales.orders.search_read",
        "odoo.finance.invoices.search_read",
        "odoo.finance.receivables.open",
        "odoo.finance.payables.open",
        "odoo.finance.revenue.period",
        "odoo.finance.cogs.period",
        "odoo.finance.margin.period_summary",
        "odoo.finance.pnl.period_summary",
        "odoo.finance.revenue.monthly",
        "odoo.finance.cogs.monthly",
        "odoo.finance.cogs.monthly_code_breakdown",
        "odoo.finance.margin.monthly_comparison",
        "odoo.finance.revenue.quarterly",
        "odoo.finance.cogs.quarterly",
        "odoo.finance.margin.quarterly_summary",
        "odoo.finance.shopify.monthly_roi",
        "odoo.finance.cash.runway_summary",
        "odoo.exploration.product_branch_sales",
        "odoo.sales.drilldown.period",
        "odoo.sales.products_gp.period_top",
    }:
        return True, None
    if operation == "odoo.rpc.query_spec":
        query_spec = normalized_payload.get("query_spec")
        if not isinstance(query_spec, dict):
            return False, "Consumer chat requires `query_spec` payload for `odoo.rpc.query_spec`"
        method = str(query_spec.get("method") or "").strip().lower()
        model = str(query_spec.get("model") or "").strip()
        if method not in {"search_read", "read_group"}:
            return False, "Consumer chat only allows query_spec methods `search_read` and `read_group`"
        if model not in generic_read_group_models and model not in generic_search_read_models:
            return (
                False,
                "Consumer chat only allows `odoo.rpc.query_spec` for approved read models (`res.company`, `account.move`, `account.move.line`, `sale.order`, `sale.order.line`, `product.template`, `product.product`)",
            )
        if str(normalized_payload.get("company_scope_lock") or "") == "single_exact":
            domain = query_spec.get("domain")
            if not isinstance(domain, list):
                return False, "company_scope_lock=single_exact requires a list `domain` on query_spec"
            has_company_clause = any(
                isinstance(clause, (list, tuple))
                and len(clause) == 3
                and str(clause[0]).strip() == "company_id"
                and str(clause[1]).strip().lower() in {"=", "in"}
                for clause in domain
            )
            terms = normalized_payload.get("company_name_terms")
            canonical = normalized_payload.get("company_scope_lock_canonical")
            has_pin_inputs = (
                isinstance(terms, list)
                and len(terms) == 1
                or (isinstance(canonical, str) and canonical.strip() != "")
            )
            if not has_company_clause and not has_pin_inputs:
                return (
                    False,
                    "company_scope_lock=single_exact requires either query_spec.domain `company_id` filter or a single company_name_terms / company_scope_lock_canonical pin",
                )
        return True, None
    if operation == "odoo.rpc.search_read":
        model = str(normalized_payload.get("model") or "").strip()
        if model in generic_search_read_models:
            return True, None
        return (
            False,
            "Consumer chat only allows `odoo.rpc.search_read` against `res.company`, `account.move`, `account.move.line`, `product.template`, or `product.product`",
        )
    if operation == "odoo.rpc.read_group":
        model = str(normalized_payload.get("model") or "").strip()
        if model in generic_read_group_models:
            return True, None
        return (
            False,
            "Consumer chat only allows `odoo.rpc.read_group` against `res.company`, `account.move`, `account.move.line`, `sale.order`, `sale.order.line`, `product.template`, or `product.product`",
        )
    if operation == "odoo.rpc.execute_kw":
        return False, "Consumer chat does not allow `odoo.rpc.execute_kw`"
    return False, f"Operation {operation!r} is not allowed for consumer chat"


def execute_tool_operation_for_agent(
    session: Session,
    *,
    agent_id: str,
    operation: str,
    payload: dict[str, Any] | None = None,
    tool_overrides: dict[str, bool] | None = None,
    surface: str = "consumer_chat",
    dry_run: bool = False,
    approval_token: str | None = None,
) -> tuple[ToolExecuteResponse, ToolReadinessSummary]:
    readiness_list = build_tool_readiness_summary(session, agent_id=agent_id, tool_overrides=tool_overrides)
    if not readiness_list:
        readiness = ToolReadinessSummary(
            id=ODOO_TOOL_ID,
            status="blocked",
            blocked_reasons=["legacy_odoo_public_surface_retired"],
            active=False,
            enabled_for_agent=False,
            session_enabled=False,
            health="unknown",
        )
        return (
            ToolExecuteResponse(
                success=False,
                message="Odoo is not available for this chat turn. legacy_odoo_public_surface_retired.",
                operation=operation,
                data={"blocked_reasons": list(readiness.blocked_reasons), "tool_status": readiness.status},
            ),
            readiness,
        )
    readiness = readiness_list[0]
    if readiness.status != "ready":
        message = "Odoo is not available for this chat turn."
        if readiness.blocked_reasons:
            message = f"{message} {'; '.join(readiness.blocked_reasons)}."
        return (
            ToolExecuteResponse(
                success=False,
                message=message,
                operation=operation,
                data={"blocked_reasons": list(readiness.blocked_reasons), "tool_status": readiness.status},
            ),
            readiness,
        )

    if surface == "consumer_chat":
        allowed, blocked_reason = _consumer_chat_operation_allowed(operation, payload)
        if not allowed:
            return (
                ToolExecuteResponse(
                    success=False,
                    message=blocked_reason or "Operation blocked for this surface.",
                    operation=operation,
                    data={"blocked_reasons": [blocked_reason] if blocked_reason else [], "tool_status": readiness.status},
                ),
                readiness,
            )

    return (
        execute_tool_operation(
            session,
            ODOO_TOOL_ID,
            operation=operation,
            payload=payload,
            dry_run=dry_run,
            approval_token=approval_token,
            actor_agent_id=agent_id,
            surface=surface,
        ),
        readiness,
    )


def _resolve_risk_class(operation: str) -> str:
    normalized = str(operation or "").strip().lower()
    if normalized in RISK_CLASS_BY_OPERATION:
        return RISK_CLASS_BY_OPERATION[normalized]
    if ".write" in normalized or ".create" in normalized or ".update" in normalized:
        return "write"
    if ".delete" in normalized or ".unlink" in normalized:
        return "destructive"
    return "read"


def _write_tool_audit_entry(
    session: Session,
    *,
    tool_id: str,
    operation: str,
    risk_class: str,
    requires_approval: bool,
    approved: bool,
    approval_token: str | None,
    actor_agent_id: str | None,
    surface: str,
    status: str,
    policy_decision_id: str,
    payload: dict[str, Any] | None,
    response: dict[str, Any] | None,
) -> None:
    audit = ToolExecutionAuditRecord(
        tool_id=tool_id,
        operation=operation,
        risk_class=risk_class,
        requires_approval=requires_approval,
        approved=approved,
        approval_token=(str(approval_token)[-8:] if approval_token else None),
        actor_agent_id=actor_agent_id,
        surface=surface,
        status=status,
        policy_decision_id=policy_decision_id,
        payload_json=dict(payload or {}),
        response_json=dict(response or {}),
    )
    session.add(audit)
    session.flush()
    if tool_id == ODOO_TOOL_ID and status == "executed":
        response_payload = dict(response or {})
        response_data = response_payload.get("data")
        trace_id = response_payload.get("trace_id")
        mirror = OdooEvidenceMirrorRecord(
            tool_audit_id=audit.id,
            trace_id=str(trace_id) if trace_id is not None else None,
            operation=operation,
            status="captured",
            source_mode="live_odoo",
            scope_json={
                "operation": operation,
                "surface": surface,
                "risk_class": risk_class,
            },
            request_json=dict(payload or {}),
            response_json={
                "success": response_payload.get("success"),
                "message": response_payload.get("message"),
                "trace_id": trace_id,
                "latency_ms": response_payload.get("latency_ms"),
                "data": response_data if isinstance(response_data, dict) else {},
            },
        )
        session.add(mirror)
    session.commit()
