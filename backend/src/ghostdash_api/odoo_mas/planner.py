from __future__ import annotations

from datetime import date

from .contracts import IntentPayload, SourceExecutionRequest, SourcePlan
from .registry_loader import get_metric_request_rules, get_policy_config


def _month_span(date_from: str, date_to: str) -> int:
    start = date.fromisoformat(date_from)
    end_exclusive = date.fromisoformat(date_to)
    if end_exclusive <= start:
        return 1
    end_inclusive = date.fromordinal(end_exclusive.toordinal() - 1)
    return ((end_inclusive.year - start.year) * 12 + (end_inclusive.month - start.month)) + 1


def _monthly_periods(date_from: str, date_to: str) -> list[tuple[str, str]]:
    start = date.fromisoformat(date_from)
    end_exclusive = date.fromisoformat(date_to)
    cursor = date(start.year, start.month, 1)
    periods: list[tuple[str, str]] = []
    while cursor < end_exclusive:
        if cursor.month == 12:
            next_month = date(cursor.year + 1, 1, 1)
        else:
            next_month = date(cursor.year, cursor.month + 1, 1)
        periods.append((cursor.isoformat(), min(next_month, end_exclusive).isoformat()))
        cursor = next_month
    return periods or [(date_from, date_to)]


def build_source_plan(intent: IntentPayload) -> SourcePlan:
    requests: list[SourceExecutionRequest] = []
    metric_rules = get_metric_request_rules()
    planner_policy = dict(metric_rules.get("planner_policy") or {})
    policy_cfg = dict(get_policy_config())
    use_monthly_margin_helper = (
        intent.granularity == "monthly"
        and any(metric in intent.metrics for metric in ("gross_profit", "gross_margin_pct", "revenue", "cogs"))
    )
    needs_profit_and_loss = any(
        metric in intent.metrics for metric in ("revenue", "cogs", "gross_profit", "gross_margin_pct", "net_profit", "roas")
    )
    if needs_profit_and_loss:
        for business_unit in intent.dimensions.get("business_unit") or [None]:
            params: dict[str, object] = {
                "date_from": intent.period.date_from,
                "date_to": intent.period.date_to,
            }
            if business_unit:
                params["company_name_terms"] = [business_unit]
            if use_monthly_margin_helper:
                params["months"] = _month_span(intent.period.date_from, intent.period.date_to)

            requests.append(
                SourceExecutionRequest(
                    source_key="profit_and_loss_monthly_margin_comparison" if use_monthly_margin_helper else "profit_and_loss",
                    system="odoo",
                    purpose=["revenue", "cogs", "net_profit", "ad_spend", "roas"],
                    params=params,
                )
            )

    needs_marketing_source = any(metric in intent.metrics for metric in ("opex_total", "marketing_costs", "ad_spend", "roas"))
    if needs_marketing_source:
        policy_overrides = dict(intent.dimensions.get("policy_overrides") or {})
        requested_business_units = list(intent.dimensions.get("business_unit") or [])
        monthly_marketing_periods = (
            _monthly_periods(intent.period.date_from, intent.period.date_to)
            if intent.intent == "multi_period_metric_trend"
            and intent.granularity == "monthly"
            and any(metric in intent.metrics for metric in ("marketing_costs", "ad_spend", "roas"))
            else [(intent.period.date_from, intent.period.date_to)]
        )
        for business_unit in _resolve_marketing_entities_for_request(
            requested_business_units=requested_business_units,
            policy_cfg=policy_cfg,
            needs_marketing_metrics=needs_marketing_source,
        ):
            for period_start, period_end in monthly_marketing_periods:
                params: dict[str, object] = {
                    "date_from": period_start,
                    "date_to": period_end,
                    "policy_overrides": policy_overrides,
                    "requested_business_units": requested_business_units,
                }
                if business_unit:
                    params["company_name_terms"] = [business_unit]
                    params["company_scope_lock"] = "single_exact"
                if requested_business_units and business_unit not in requested_business_units:
                    params["centralized_marketing_source_entity"] = business_unit
                requests.append(
                    SourceExecutionRequest(
                        source_key="opex_ledger_search",
                        system="odoo",
                        purpose=["opex_total", "marketing_costs", "marketing_cost_total"],
                        params=params,
                    )
                )

    if any(metric in intent.metrics for metric in ("cash_balance",)):
        requests.append(
            SourceExecutionRequest(
                source_key="cash_flow",
                system="odoo",
                purpose=["cash_balance"],
                params={
                    "date_from": intent.period.date_from,
                    "date_to": intent.period.date_to,
                    "company_name_terms": intent.dimensions.get("business_unit") or [],
                },
            )
        )

    if any(metric in intent.metrics for metric in ("ar_balance",)):
        requests.append(
            SourceExecutionRequest(
                source_key="aged_receivables",
                system="odoo",
                purpose=["ar_balance"],
                params={"limit": 100},
            )
        )
    if any(metric in intent.metrics for metric in ("ap_balance",)):
        requests.append(
            SourceExecutionRequest(
                source_key="aged_payables",
                system="odoo",
                purpose=["ap_balance"],
                params={"limit": 100},
            )
        )

    if _is_metric_request(intent):
        requests = _enforce_metric_first_path(
            intent=intent,
            requests=requests,
            planner_policy=planner_policy,
        )

    return SourcePlan(
        sources=requests,
        derived_metrics=[
            {"metric": "gross_profit", "formula": "revenue - cogs"},
            {"metric": "gross_margin_pct", "formula": "gross_profit / revenue"},
            {"metric": "roas", "formula": "revenue / marketing_cost_total"},
            {"metric": "marketing_cost_total", "formula": "sum(classified_opex where account_class in marketing_policy_scope)"},
            {"metric": "marketing_costs", "formula": "marketing_cost_total"},
        ],
    )


def _is_metric_request(intent: IntentPayload) -> bool:
    metric_request_metrics = {
        "revenue",
        "cogs",
        "gross_profit",
        "gross_margin_pct",
        "net",
        "net_profit",
        "marketing_costs",
        "ad_spend",
        "roas",
        "cash_balance",
        "ar_balance",
        "ap_balance",
    }
    return any(metric in metric_request_metrics for metric in intent.metrics)


def _enforce_metric_first_path(
    *,
    intent: IntentPayload,
    requests: list[SourceExecutionRequest],
    planner_policy: dict[str, object],
) -> list[SourceExecutionRequest]:
    block_ledger_primary = bool(planner_policy.get("block_ledger_search_primary_for_metric_requests", True))
    if not block_ledger_primary:
        return requests

    has_non_ledger_primary = any(request.source_key != "opex_ledger_search" for request in requests)
    if has_non_ledger_primary:
        return requests

    # Metric requests cannot run on ledger-search-only plans.
    for business_unit in intent.dimensions.get("business_unit") or [None]:
        params: dict[str, object] = {
            "date_from": intent.period.date_from,
            "date_to": intent.period.date_to,
        }
        if business_unit:
            params["company_name_terms"] = [business_unit]
        requests.insert(
            0,
            SourceExecutionRequest(
                source_key="profit_and_loss",
                system="odoo",
                purpose=["revenue", "cogs", "net_profit", "ad_spend", "roas"],
                params=params,
            ),
        )
    return requests


def _resolve_marketing_entities_for_request(
    *,
    requested_business_units: list[str],
    policy_cfg: dict[str, object],
    needs_marketing_metrics: bool,
) -> list[str | None]:
    if not needs_marketing_metrics:
        return requested_business_units or [None]
    mode = str(policy_cfg.get("marketing_mode") or "").strip().casefold()
    primary = str(policy_cfg.get("primary_entity") or "").strip()
    if mode == "centralized" and primary:
        return [_entity_to_business_unit(primary)]
    return requested_business_units or [None]


def _entity_to_business_unit(entity: str) -> str:
    normalized = str(entity or "").strip().casefold()
    if normalized == "retail":
        return "Ride Electric Retail"
    if normalized == "brisbane":
        return "Ride Electric Brisbane"
    if normalized == "burleigh":
        return "Ride Electric Burleigh"
    return entity
