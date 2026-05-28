from __future__ import annotations

from sqlalchemy.orm import Session

from ..tool_registry import execute_tool_operation
from .contracts import SourceExecutionRequest


_SOURCE_TO_OPERATION = {
    "profit_and_loss": "odoo.finance.pnl.period_summary",
    "profit_and_loss_monthly_margin_comparison": "odoo.finance.margin.monthly_comparison",
    "opex_ledger_search": "odoo.finance.pnl.period_summary",
    "cash_flow": "odoo.finance.cash.runway_summary",
    "aged_receivables": "odoo.finance.receivables.open",
    "aged_payables": "odoo.finance.payables.open",
    "balance_sheet_fallback": "odoo.rpc.search_read",
}


def execute_source_request(session: Session, request: SourceExecutionRequest) -> dict:
    operation = _SOURCE_TO_OPERATION.get(request.source_key)
    if not operation:
        return {
            "success": False,
            "source_key": request.source_key,
            "error": f"Unsupported source_key `{request.source_key}`",
        }

    payload = _resolve_extraction_payload(request)
    result = execute_tool_operation(
        session,
        "odoo_primary",
        operation=operation,
        payload=payload,
        dry_run=False,
        actor_agent_id="odoo_mas_pipeline",
        surface="odoo_mas",
    )
    data = dict(result.data or {})
    if request.source_key == "opex_ledger_search":
        # Phase 1 hardening: use accounting report engine dataset, not partial query-spec pulls.
        data.setdefault("policy_overrides", dict(request.params.get("policy_overrides") or {}))
        data.setdefault("date_from", request.params.get("date_from"))
        data.setdefault("date_to", request.params.get("date_to"))
        if request.params.get("company_name_terms"):
            data.setdefault("company_name_terms", list(request.params.get("company_name_terms") or []))
        if request.params.get("requested_business_units"):
            data.setdefault("requested_business_units", list(request.params.get("requested_business_units") or []))
        account_rows = list(data.get("account_rows") or [])
        ledger_rows: list[dict[str, object]] = []
        for row in account_rows:
            if not isinstance(row, dict):
                continue
            normalized_amount = row.get("normalized_amount")
            if normalized_amount is None:
                continue
            try:
                account_id = int(row.get("account_id"))
                amount = float(normalized_amount)
            except (TypeError, ValueError):
                continue
            account_code = str(row.get("account_code") or account_id)
            account_name = str(row.get("account_name") or account_code)
            account_ref: int | str = account_id
            if account_code.isdigit():
                account_ref = int(account_code)
            ledger_rows.append(
                {
                    "account_id": [account_ref, f"{account_code} {account_name}".strip()],
                    "balance": amount,
                    "date:month": str(request.params.get("date_from") or "")[:7] + "-01",
                }
            )
        data["rows"] = ledger_rows
        data["evidence_source_mode"] = "odoo_accounting_report_engine"
    return {
        "success": bool(result.success),
        "source_key": request.source_key,
        "operation": operation,
        "message": result.message,
        "data": data,
    }


def _resolve_extraction_payload(request: SourceExecutionRequest) -> dict[str, object]:
    payload = dict(request.params)
    if request.source_key != "opex_ledger_search":
        return payload
    # Centralized marketing mode must extract from primary entity scope.
    primary_scope = str(payload.get("centralized_marketing_source_entity") or "").strip()
    if primary_scope:
        payload["company_name_terms"] = [primary_scope]
        payload["company_scope_lock"] = "single_exact"
        payload.pop("company_ids", None)
    return payload
