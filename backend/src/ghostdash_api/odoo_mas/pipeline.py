from __future__ import annotations

import re

from sqlalchemy.orm import Session

from ..finance_report_renderer import build_finance_answer_payload, persist_finance_report
from .assembler import build_metric_pack
from .composer import compose_board_markdown
from .contracts import MetricPack, SourceExecutionRequest
from .extractors import execute_source_request
from .normalizers import normalize_source_result
from .observability import log_stage
from .phase2_bridge import apply_phase2_resolved_metrics_to_metric_pack, build_phase2_payload, format_phase2_markdown_append
from .planner import build_source_plan
from .quality_flags import build_quality_flags
from .reasoner import reason_about_metric_pack
from .registry_loader import get_metric_request_rules
from .router import route_intent


def run_odoo_mas_pipeline(session: Session, *, message: str, trace_id: str | None = None) -> dict:
    intent = route_intent(message)
    log_stage("intent_routed", trace_id=trace_id, status="ok", payload=intent.model_dump())

    if "net_definition_required" in intent.ambiguities:
        return {
            "success": False,
            "status": "blocked",
            "reason": "metric_missing",
            "message": "NET is blocked until business definition is approved.",
            "intent": intent.model_dump(),
        }

    source_plan = build_source_plan(intent)
    log_stage("source_plan", trace_id=trace_id, status="ok", payload=source_plan.model_dump())

    normalized_reports = []
    failures = []
    for source in source_plan.sources:
        raw = execute_source_request(session, source)
        if not raw.get("success"):
            failures.append(raw)
            continue
        normalized_reports.append(normalize_source_result(source.source_key, raw))

    metric_pack: MetricPack = build_metric_pack(normalized_reports)
    metric_gate = _require_metric_pack_for_finance_intent(intent=intent, metric_pack=metric_pack)
    if metric_gate is not None:
        return {
            "success": False,
            "status": "blocked",
            "reason": "metric_missing",
            "message": metric_gate["message"],
            "intent": intent.model_dump(),
            "source_plan": source_plan.model_dump(),
            "metric_pack": metric_pack.model_dump(),
            "failures": failures,
        }

    marketing_coverage_gate = _require_marketing_account_coverage(intent=intent, reports=normalized_reports)
    if marketing_coverage_gate is not None:
        return {
            "success": False,
            "status": "blocked",
            "reason": "metric_missing",
            "message": marketing_coverage_gate["message"],
            "intent": intent.model_dump(),
            "source_plan": source_plan.model_dump(),
            "metric_pack": metric_pack.model_dump(),
            "failures": failures,
        }

    quality_flags = build_quality_flags(normalized_reports)
    metric_pack.gaps.extend(flag for flag in quality_flags if flag not in metric_pack.gaps)
    _suppress_resolved_metric_gaps(intent=intent, metric_pack=metric_pack)
    primary_metric_gate = _require_primary_metric_for_request(intent=intent, metric_pack=metric_pack)
    if primary_metric_gate is not None:
        return {
            "success": False,
            "status": "blocked",
            "reason": "metric_missing",
            "message": primary_metric_gate["message"],
            "intent": intent.model_dump(),
            "source_plan": source_plan.model_dump(),
            "metric_pack": metric_pack.model_dump(),
            "failures": failures,
        }

    presented_metric_pack = metric_pack.model_copy(deep=True)
    if intent.intent == "multi_period_metric_trend":
        presented_metric_pack.ledger_rows = []

    phase2 = build_phase2_payload(presented_metric_pack)
    apply_phase2_resolved_metrics_to_metric_pack(presented_metric_pack, phase2)
    _suppress_resolved_metric_gaps(intent=intent, metric_pack=presented_metric_pack)
    reasoning = reason_about_metric_pack(presented_metric_pack)
    chat_summary_card = build_finance_answer_payload(
        presented_metric_pack,
        phase2=phase2,
        reasoning=reasoning,
        operation="odoo.mas.intent.auto_route",
    )
    apryse_report_document = persist_finance_report(chat_summary_card)
    centralized_note = _build_centralized_marketing_note(source_plan=source_plan)
    markdown = compose_board_markdown(
        presented_metric_pack,
        reasoning,
        requested_metrics=intent.metrics,
        centralized_note=centralized_note,
        intent_kind=intent.intent,
        include_ledger_evidence=intent.include_ledger_evidence,
    )
    md_append = format_phase2_markdown_append(phase2)
    if md_append:
        markdown = f"{markdown.rstrip()}\n{md_append}"

    return {
        "success": True,
        "intent": intent.model_dump(),
        "source_plan": source_plan.model_dump(),
        "metric_pack": presented_metric_pack.model_dump(),
        "reasoning": reasoning.model_dump(),
        "markdown": markdown,
        "chat_summary_card": chat_summary_card,
        "apryse_report_document": apryse_report_document,
        "centralized_marketing_note": centralized_note,
        "phase2": phase2,
        "failures": failures,
    }


def _suppress_resolved_metric_gaps(*, intent, metric_pack: MetricPack) -> None:
    """Remove source-level quality flags once the final semantic metric is resolved.

    Example: branch P&L reports may not carry a direct ROAS value, but centralized
    marketing can resolve ROAS after Retail marketing evidence is merged.
    """
    requested = {str(metric).strip() for metric in list(intent.metrics or []) if str(metric).strip()}
    if "roas" in requested and metric_pack.rows and all(row.roas is not None for row in metric_pack.rows):
        metric_pack.gaps = [
            gap
            for gap in metric_pack.gaps
            if gap not in {"missing:roas", "roas_unavailable", "roas_status:unavailable"}
            and not str(gap).endswith(":roas:missing_value")
        ]


def _require_metric_pack_for_finance_intent(*, intent, metric_pack: MetricPack) -> dict[str, str] | None:
    rules = get_metric_request_rules()
    planner_policy = dict(rules.get("planner_policy") or {})
    if not bool(planner_policy.get("require_metric_pack_before_composer", True)):
        return None
    if not _is_finance_metric_request(intent.metrics):
        return None
    if not metric_pack.rows:
        return {
            "blocked_reason": "metric_pack_missing",
            "message": "Finance/Odoo request blocked: semantic metric pack was not produced.",
        }
    if all(
        row.revenue is None
        and row.cogs is None
        and row.gross_profit is None
        and row.net_profit is None
        and row.ad_spend is None
        and row.roas is None
        for row in metric_pack.rows
    ):
        return {
            "blocked_reason": "metric_pack_empty",
            "message": "Finance/Odoo request blocked: metric pack did not contain usable metrics.",
        }
    return None


def _is_finance_metric_request(metrics: list[str]) -> bool:
    finance_metrics = {
        "revenue",
        "cogs",
        "gross_profit",
        "gross_margin_pct",
        "gross_margin",
        "contribution_margin",
        "net",
        "net_profit",
        "marketing_costs",
        "ad_spend",
        "roas",
        "cash_balance",
        "ar_balance",
        "ap_balance",
        "opex_total",
    }
    return any(metric in finance_metrics for metric in metrics)


def _require_primary_metric_for_request(*, intent, metric_pack: MetricPack) -> dict[str, str] | None:
    metric_to_reader = {
        "revenue": lambda row: row.revenue,
        "cogs": lambda row: row.cogs,
        "gross_profit": lambda row: row.gross_profit,
        "gross_margin": lambda row: (row.gross_profit / row.revenue) if row.gross_profit is not None and row.revenue not in (None, 0) else None,
        "contribution_margin": lambda row: ((row.gross_profit - row.marketing_cost_total) / row.revenue)
        if row.gross_profit is not None and row.marketing_cost_total is not None and row.revenue not in (None, 0)
        else None,
        "net": lambda row: row.net_profit,
        "net_profit": lambda row: row.net_profit,
        "roas": lambda row: row.roas,
        "ad_spend": lambda row: row.marketing_cost_total,
        "marketing_costs": lambda row: row.marketing_cost_total,
    }
    requested = [metric for metric in intent.metrics if metric in metric_to_reader]
    if not requested:
        return None

    missing: list[str] = []
    for metric in requested:
        getter = metric_to_reader[metric]
        has_value = any(getter(row) is not None for row in metric_pack.rows)
        if not has_value:
            missing.append(metric)
    if missing:
        return {
            "blocked_reason": "primary_metric_missing",
            "message": f"Finance/Odoo request blocked: primary metric(s) missing: {', '.join(sorted(set(missing)))}.",
        }
    return None


def _build_centralized_marketing_note(*, source_plan) -> str | None:
    for source in source_plan.sources:
        if source.source_key != "opex_ledger_search":
            continue
        requested = list(source.params.get("requested_business_units") or [])
        centralized = str(source.params.get("centralized_marketing_source_entity") or "").strip()
        if requested and centralized:
            return (
                f"requested entity = {', '.join(str(item) for item in requested)}; "
                f"source posting entity = {centralized}."
            )
    return None


def _require_marketing_account_coverage(*, intent, reports: list[object]) -> dict[str, str] | None:
    if "marketing_costs" not in list(intent.metrics or []) and "ad_spend" not in list(intent.metrics or []):
        return None
    catalog_names: set[str] = set()
    catalog_codes: set[int] = set()
    explicit_required: set[str] = set()
    for report in reports:
        if getattr(report, "report_key", "") != "opex_ledger_search":
            continue
        meta = dict(getattr(report, "metadata", {}) or {})
        for item in list(meta.get("expected_marketing_accounts") or []):
            value = str(item).strip()
            if not value:
                continue
            catalog_names.add(value)
            code_match = re.match(r"^\s*(\d{3,4})\b", value)
            if code_match:
                catalog_codes.add(int(code_match.group(1)))
        overrides = dict(meta.get("policy_overrides") or {})
        for item in list(overrides.get("required_marketing_accounts") or []):
            value = str(item).strip()
            if value:
                explicit_required.add(value)

    unknown_required: list[str] = []
    for required in sorted(explicit_required):
        code_match = re.match(r"^\s*(\d{3,4})\b", required)
        if code_match and int(code_match.group(1)) in catalog_codes:
            continue
        if required in catalog_names:
            continue
        unknown_required.append(required)
    if unknown_required:
        return {
            "message": "Finance/Odoo request blocked: unknown required marketing accounts not present in classification catalog: "
            + ", ".join(unknown_required)
        }
    return None


def get_classified_ledger_rows(
    session: Session,
    *,
    entity: str,
    date_from: str,
    date_to: str,
) -> dict[str, object]:
    business_unit = _entity_to_business_unit(entity)
    request = SourceExecutionRequest(
        source_key="opex_ledger_search",
        system="odoo",
        purpose=["ledger_classification"],
        params={
            "date_from": date_from,
            "date_to": date_to,
            "company_name_terms": [business_unit],
            "company_scope_lock": "single_exact",
            "query_spec": {
                "model": "account.move.line",
                "method": "read_group",
                "domain": [
                    ["parent_state", "=", "posted"],
                    ["date", ">=", date_from],
                    ["date", "<", date_to],
                    ["account_id.account_type", "in", ["expense", "expense_depreciation", "expense_direct_cost"]],
                ],
                "fields": ["balance:sum", "account_id"],
                "groupby": ["account_id", "date:month"],
                "orderby": "date:month asc",
                "lazy": False,
            },
        },
    )
    raw = execute_source_request(session, request)
    if not raw.get("success"):
        return {
            "status": "blocked",
            "reason": "ledger_unavailable",
            "entity": business_unit,
            "date_from": date_from,
            "date_to": date_to,
            "rows": [],
            "error": raw.get("error") or "Unable to classify ledger rows.",
        }
    report = normalize_source_result("opex_ledger_search", raw)
    classified = list(report.metadata.get("ledger_rows") or [])
    output_rows = []
    for row in classified:
        output_rows.append(
            {
                "account": str(row.get("account") or "unknown"),
                "amount": abs(float(row.get("amount") or 0.0)),
                "account_class": row.get("account_class"),
                "include_in_metric": bool(row.get("include_in_metric", False)),
            }
        )
    return {
        "status": "ok",
        "entity": business_unit,
        "date_from": date_from,
        "date_to": date_to,
        "rows": output_rows,
    }


def _entity_to_business_unit(entity: str) -> str:
    normalized = str(entity or "").strip().casefold()
    if normalized == "retail":
        return "Ride Electric Retail"
    if normalized == "brisbane":
        return "Ride Electric Brisbane"
    if normalized == "burleigh":
        return "Ride Electric Burleigh"
    return " ".join(str(entity or "").strip().split()).title() or "Ride Electric Retail"
