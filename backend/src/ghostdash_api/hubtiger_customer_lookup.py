"""Fast HubTiger cyclist lookup by phone — first/last name only."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from .hubtiger_mcp import build_hubtiger_execute_request
from .schemas import HubTigerCustomerByPhoneResponse
from .settings import get_settings

logger = logging.getLogger(__name__)


def normalize_phone_for_customer_search(phone: str | None) -> str:
    """Normalize AU mobiles to local 04xxxxxxxx for API responses and proxy search."""
    raw = str(phone or "").strip()
    if not raw:
        return ""
    digits = "".join(ch for ch in raw if ch.isdigit())
    if len(digits) == 11 and digits.startswith("61"):
        return f"0{digits[2:]}"
    if len(digits) == 10 and digits.startswith("04"):
        return digits
    if len(digits) == 9 and digits.startswith("4"):
        return f"0{digits}"
    if len(digits) == 10 and digits.startswith("0"):
        return digits
    return raw


def extract_customer_name(row: dict[str, Any]) -> tuple[str | None, str | None]:
    first = str(row.get("Name") or row.get("first_name") or row.get("FirstName") or "").strip()
    last = str(row.get("Surname") or row.get("last_name") or row.get("LastName") or "").strip()
    if first or last:
        return first or None, last or None
    description = str(row.get("CyclistDescription") or row.get("name") or row.get("customerName") or "").strip()
    if not description:
        return None, None
    parts = description.split()
    if len(parts) >= 2:
        return parts[0], " ".join(parts[1:])
    return description, None


def _pick_best_match(rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    for row in rows:
        if isinstance(row, dict):
            return row
    return None


def _normalize_jobcard_no(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return raw.lstrip("#")


def _extract_job_context(
    match: dict[str, Any],
    variables: dict[str, Any] | None,
) -> tuple[str | None, str | None, str | None, str | None]:
    vars_map = variables if isinstance(variables, dict) else {}
    jobcard_obj = match.get("jobcard") if isinstance(match.get("jobcard"), dict) else {}

    model = (
        str(vars_map.get("Model") or "").strip()
        or str(jobcard_obj.get("bike") or "").strip()
        or None
    )
    jobcard = (
        _normalize_jobcard_no(vars_map.get("Jobcard"))
        or _normalize_jobcard_no(jobcard_obj.get("jobCardNo"))
        or None
    )
    date_checked_in = (
        str(vars_map.get("DateCheckedIn") or "").strip()
        or str(jobcard_obj.get("dateCheckedIn") or jobcard_obj.get("dateBookedIn") or "").strip()
        or None
    )
    location = (
        str(vars_map.get("Location") or vars_map.get("Workshop") or "").strip()
        or str(jobcard_obj.get("workshop") or "").strip()
        or None
    )
    return model, jobcard, date_checked_in, location


def _build_display_name(first_name: str | None, last_name: str | None) -> str | None:
    parts = [str(first_name or "").strip(), str(last_name or "").strip()]
    name = " ".join(part for part in parts if part)
    return name or None


async def lookup_customer_by_phone(*, phone: str, trace_id: str) -> HubTigerCustomerByPhoneResponse:
    settings = get_settings()
    normalized_phone = normalize_phone_for_customer_search(phone)
    if not normalized_phone:
        return HubTigerCustomerByPhoneResponse(
            success=False,
            found=False,
            message="A phone number is required.",
            phone="",
            error_code="missing_phone",
        )

    base_url = str(settings.hubtiger_mcp_url or "").strip().rstrip("/")
    if not base_url:
        return HubTigerCustomerByPhoneResponse(
            success=False,
            found=False,
            message="HubTiger is not configured for this environment.",
            phone=normalized_phone,
            error_code="hubtiger_mcp_not_configured",
        )

    timeout_s = max(3.0, int(settings.hubtiger_customer_lookup_timeout_ms or 12000) / 1000.0)
    execute_request = build_hubtiger_execute_request(
        "customer_search",
        {"q": normalized_phone, "type": "phone", "limit": 1, "page": 0},
    )
    if not execute_request:
        return HubTigerCustomerByPhoneResponse(
            success=False,
            found=False,
            message="Could not build HubTiger customer search request.",
            phone=normalized_phone,
            error_code="invalid_request",
        )

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            upstream = await client.post(f"{base_url}/execute", json=execute_request)
        if upstream.status_code >= 400:
            logger.info(
                json.dumps(
                    {
                        "trace_id": trace_id,
                        "span_id": trace_id[:16],
                        "service": "control-api",
                        "route": "/api/elevenlabs/hubtiger/customer-by-phone",
                        "phone": normalized_phone,
                        "status": "error",
                        "error": f"upstream_status_{upstream.status_code}",
                        "error_code": "hubtiger_unavailable",
                    },
                    ensure_ascii=True,
                )
            )
            return HubTigerCustomerByPhoneResponse(
                success=False,
                found=False,
                message="Customer lookup is temporarily unavailable. Please try again shortly.",
                phone=normalized_phone,
                error_code="hubtiger_unavailable",
            )
        body = upstream.json() if upstream.content else {}
        payload = body.get("data") if isinstance(body, dict) else {}
        if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
            payload = payload["data"]
        variables: dict[str, Any] = {}
        if isinstance(payload, dict) and isinstance(payload.get("variables"), dict):
            variables = payload["variables"]
        rows: list[dict[str, Any]] = []
        if isinstance(payload, dict):
            raw_rows = payload.get("results") or payload.get("cyclists")
            if isinstance(raw_rows, list):
                rows = [row for row in raw_rows if isinstance(row, dict)]
        if not rows:
            logger.info(
                json.dumps(
                    {
                        "trace_id": trace_id,
                        "span_id": trace_id[:16],
                        "service": "control-api",
                        "route": "/api/elevenlabs/hubtiger/customer-by-phone",
                        "phone": normalized_phone,
                        "found": False,
                        "status": "ok",
                        "error": None,
                    },
                    ensure_ascii=True,
                )
            )
            return HubTigerCustomerByPhoneResponse(
                success=True,
                found=False,
                message="No customer was found for that phone number.",
                phone=normalized_phone,
            )
        match = _pick_best_match(rows)
        if not match:
            return HubTigerCustomerByPhoneResponse(
                success=True,
                found=False,
                message="No customer was found for that phone number.",
                phone=normalized_phone,
            )
        first_name, last_name = extract_customer_name(match)
        found = bool(first_name or last_name)
        model, jobcard, date_checked_in, location = _extract_job_context(match, variables)
        display_name = _build_display_name(first_name, last_name)
        logger.info(
            json.dumps(
                {
                    "trace_id": trace_id,
                    "span_id": trace_id[:16],
                    "service": "control-api",
                    "route": "/api/elevenlabs/hubtiger/customer-by-phone",
                    "phone": normalized_phone,
                    "found": found,
                    "has_jobcard": bool(jobcard),
                    "status": "ok",
                    "error": None,
                },
                ensure_ascii=True,
            )
        )
        return HubTigerCustomerByPhoneResponse(
            success=True,
            found=found,
            message="Customer found." if found else "Customer record found but name was not available.",
            phone=normalized_phone,
            first_name=first_name,
            last_name=last_name,
            customer_id=str(match.get("ID") or match.get("id") or "") or None,
            model=model,
            jobcard=jobcard,
            date_checked_in=date_checked_in,
            location=location,
            name=display_name,
            Name=display_name,
            Jobcard=jobcard,
            Model=model,
            Workshop=location,
            Location=location,
            DateCheckedIn=date_checked_in,
        )
    except httpx.TimeoutException:
        logger.info(
            json.dumps(
                {
                    "trace_id": trace_id,
                    "span_id": trace_id[:16],
                    "service": "control-api",
                    "route": "/api/elevenlabs/hubtiger/customer-by-phone",
                    "phone": normalized_phone,
                    "status": "error",
                    "error": "timeout",
                    "error_code": "hubtiger_timeout",
                },
                ensure_ascii=True,
            )
        )
        return HubTigerCustomerByPhoneResponse(
            success=False,
            found=False,
            message="Customer lookup timed out. Please try again.",
            phone=normalized_phone,
            error_code="hubtiger_timeout",
        )
    except Exception:
        logger.info(
            json.dumps(
                {
                    "trace_id": trace_id,
                    "span_id": trace_id[:16],
                    "service": "control-api",
                    "route": "/api/elevenlabs/hubtiger/customer-by-phone",
                    "phone": normalized_phone,
                    "status": "error",
                    "error": "unexpected",
                    "error_code": "hubtiger_lookup_failed",
                },
                ensure_ascii=True,
            )
        )
        return HubTigerCustomerByPhoneResponse(
            success=False,
            found=False,
            message="Customer lookup failed. Please try again shortly.",
            phone=normalized_phone,
            error_code="hubtiger_lookup_failed",
        )
