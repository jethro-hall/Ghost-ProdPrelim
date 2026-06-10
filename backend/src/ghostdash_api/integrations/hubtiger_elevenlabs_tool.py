"""Lookup-only ElevenLabs HubTiger public API surface under /api."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from httpx import ConnectError, RequestError, TimeoutException

from uuid import uuid4

from ghostdash_api.hubtiger_customer_lookup import lookup_customer_by_phone
from ghostdash_api.schemas import (
    ElevenLabsHubTigerToolRequest,
    HubTigerCustomerByPhoneResponse,
    HubTigerCustomerIdentifier,
    PublicToolResult,
)
from ghostdash_api.settings import get_settings
from ghostdash_api.voice_ingress import _check_hubtiger_voice_auth
from integrations.elevenlabs_hubtiger.router import run_elevenlabs_hubtiger_tool_request

from .hubtiger_elevenlabs_schemas import HubTigerCustomerByPhoneRequest, HubTigerElevenLabsLookupRequest

router = APIRouter(prefix="/api/elevenlabs/hubtiger", tags=["elevenlabs-hubtiger-lookup"])


@router.get("/health")
async def hubtiger_health(request: Request) -> JSONResponse:
    _check_hubtiger_voice_auth(request)
    settings = get_settings()
    mcp_url = str(settings.hubtiger_mcp_url or "").strip().rstrip("/")
    health_ms = max(250, int(settings.hubtiger_mcp_health_timeout_ms or 4000))
    if not mcp_url:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "service": "elevenlabs-hubtiger",
                "ready": False,
                "error_code": "hubtiger_mcp_url_missing",
                "message": "HubTiger MCP URL is not configured. Set HUBTIGER_MCP_URL for this environment.",
            },
        )
    timeout_sec = health_ms / 1000.0
    try:
        async with httpx.AsyncClient(timeout=timeout_sec) as client:
            response = await client.get(f"{mcp_url}/health")
        if response.status_code >= 400:
            return JSONResponse(
                status_code=503,
                content={
                    "ok": False,
                    "service": "elevenlabs-hubtiger",
                    "ready": False,
                    "error_code": "hubtiger_mcp_unhealthy",
                    "message": "The HubTiger backend health check returned an error. Check MCP and proxy services.",
                },
            )
    except TimeoutException:
        return JSONResponse(
            status_code=504,
            content={
                "ok": False,
                "service": "elevenlabs-hubtiger",
                "ready": False,
                "error_code": "hubtiger_mcp_health_timeout",
                "message": (
                    f"The HubTiger connection check timed out after {health_ms} ms. "
                    "Retry shortly; if this persists, the MCP service may be overloaded or unreachable."
                ),
                "timeout_ms": health_ms,
            },
        )
    except ConnectError:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "service": "elevenlabs-hubtiger",
                "ready": False,
                "error_code": "hubtiger_mcp_unreachable",
                "message": "Could not open a connection to the HubTiger MCP service. Verify it is running and on the same Docker network as control-api.",
            },
        )
    except RequestError:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "service": "elevenlabs-hubtiger",
                "ready": False,
                "error_code": "hubtiger_mcp_request_failed",
                "message": "The HubTiger MCP health request failed before a response was received.",
            },
        )
    except Exception:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "service": "elevenlabs-hubtiger",
                "ready": False,
                "error_code": "hubtiger_mcp_health_error",
                "message": "An unexpected error occurred while checking HubTiger MCP health.",
            },
        )
    return JSONResponse(
        status_code=200,
        content={
            "ok": True,
            "service": "elevenlabs-hubtiger",
            "ready": True,
            "mode": "read_only",
            "surface": "read_tools",
            "health_check_timeout_ms": health_ms,
        },
    )


@router.post("/customer-by-phone", response_model=HubTigerCustomerByPhoneResponse)
async def hubtiger_customer_by_phone(
    body: HubTigerCustomerByPhoneRequest,
    request: Request,
) -> HubTigerCustomerByPhoneResponse:
    """Fast HubTiger cyclist lookup: phone in, first/last name out."""
    _check_hubtiger_voice_auth(request)
    trace_id = str(getattr(request.state, "trace_id", "") or "") or uuid4().hex
    return await lookup_customer_by_phone(phone=body.phone, trace_id=trace_id)


@router.post("/tool", response_model=PublicToolResult)
async def hubtiger_lookup_tool(body: HubTigerElevenLabsLookupRequest, request: Request) -> PublicToolResult:
    fn = str(body.function or "").strip().lower()
    allowed_read_functions = {
        "lookup_job",
        "job_lookup",
        "job_search",
        "job_retrieve",
        "booking_availability",
        "availability_lookup",
        "quote_preview",
        "booking_slot_hold",
        "booking_customer_search",
        "booking_bike_list",
        "booking_service_set",
    }
    allowed_write_functions = {
        "booking_customer_confirm",
        "booking_bike_confirm",
        "booking_submit",
        "booking_finalize",
        "booking_create",
    }
    if fn not in allowed_read_functions and fn not in allowed_write_functions:
        raise HTTPException(
            status_code=422,
            detail=(
                "Supported functions: job lookup/search/retrieve, booking_availability, quote_preview, "
                "booking_slot_hold, booking_customer_search, booking_bike_list, "
                "booking_service_set, booking_customer_confirm, booking_bike_confirm, booking_submit, booking_finalize, booking_create."
            ),
        )

    payload = dict(body.payload or {})
    if body.phone and "phone" not in payload:
        payload["phone"] = body.phone
    if body.first_name and "first_name" not in payload:
        payload["first_name"] = body.first_name
    if body.last_name and "last_name" not in payload:
        payload["last_name"] = body.last_name
    if body.job_id and "job_id" not in payload:
        payload["job_id"] = body.job_id
    if body.job_card_no and "job_card_no" not in payload:
        payload["job_card_no"] = body.job_card_no
    if body.start_date and "start_date" not in payload:
        payload["start_date"] = body.start_date
    if body.end_date and "end_date" not in payload:
        payload["end_date"] = body.end_date

    canonical = ElevenLabsHubTigerToolRequest(
        function=fn or "lookup_job",
        cache_mode=body.cache_mode,
        store=body.store,
        date=body.date,
        start_date=body.start_date,
        end_date=body.end_date,
        customer=(
            HubTigerCustomerIdentifier(
                phone=body.phone,
                first_name=body.first_name,
                last_name=body.last_name,
            )
            if body.phone or body.first_name or body.last_name
            else None
        ),
        payload=payload,
    )
    result = await run_elevenlabs_hubtiger_tool_request(
        body=canonical,
        request=request,
    )
    case_select = result.data.get("case_select") if isinstance(result.data, dict) else None
    if isinstance(case_select, dict):
        selection_required = bool(case_select.get("selection_required"))
        store_verification = str(case_select.get("store_verification") or "").strip().lower()
        if selection_required and store_verification in {"mismatch", "unknown"}:
            return PublicToolResult(
                success=True,
                blocked=False,
                operation=result.operation,
                message=str(case_select.get("assistant_prompt") or "Please confirm the correct store or select the exact job card."),
                data=result.data,
            )
    return result
