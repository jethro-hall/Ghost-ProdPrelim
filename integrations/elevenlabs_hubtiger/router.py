from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from .schemas import (
    BookingAvailabilityIn,
    BookingCreateIn,
    JobGetIn,
    JobNoteAddIn,
    JobSearchIn,
    ProductSearchIn,
    PublicToolResult,
    QuoteAddLineItemIn,
    QuoteApprovalIn,
    QuotePreviewIn,
)

router = APIRouter(prefix="/api/elevenlabs/hubtiger", tags=["elevenlabs-hubtiger"])

READ_TOOLS = {
    "booking_availability": "hubtiger_booking_availability",
    "job_search": "hubtiger_job_search",
    "job_get": "hubtiger_job_get",
    "products_search": "hubtiger_products_search",
    "quote_preview": "hubtiger_quote_preview_price",
}

WRITE_TOOLS = {
    "booking_create": "hubtiger_booking_create",
    "job_note_add": "hubtiger_job_note_add",
    "quote_add_line_item": "hubtiger_quote_add_line_item",
    "quote_request_approval_sms": "hubtiger_quote_request_approval_sms",
}


def require_tool_auth(request: Request) -> None:
    expected = os.getenv("ELEVENLABS_HUBTIGER_WEBHOOK_SECRET", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Tool webhook not configured")

    supplied = request.headers.get("X-Ghost-Voice-Key", "").strip()
    auth = request.headers.get("Authorization", "").strip()
    if not supplied and auth.lower().startswith("bearer "):
        supplied = auth[7:].strip()

    if supplied != expected:
        raise HTTPException(status_code=401, detail="Unauthorised")


def is_read_write() -> bool:
    return os.getenv("HUBTIGER_TOOL_ACCESS", "read_only").strip().lower() == "read_write"


def read_only_block() -> PublicToolResult:
    return PublicToolResult(
        success=False,
        public_message="I can check that for you, but booking or changes are not enabled yet.",
        error_code="hubtiger_read_only_mode",
        retryable=False,
    )


async def call_existing_hubtiger(tool_name: str, payload: Any) -> PublicToolResult:
    """Facade hook.

    Cursor must wire this to the real GhostDash HubTiger tool adapter.
    Keep this file as the ElevenLabs-facing policy boundary.
    """
    try:
        from hubtiger_magic_mike_tool import __dict__ as tools
    except Exception:
        tools = {}

    func = tools.get(tool_name)
    if not func:
        return PublicToolResult(
            success=False,
            public_message="That Ride Electric system is not connected here yet.",
            error_code="hubtiger_adapter_not_wired",
            retryable=False,
        )

    try:
        result = func(payload)
        if hasattr(result, "__await__"):
            result = await result
        if hasattr(result, "model_dump"):
            result = result.model_dump()
        if isinstance(result, dict):
            return PublicToolResult(**{
                "success": bool(result.get("success")),
                "public_message": result.get("public_message") or "Done.",
                "data": result.get("data") or {},
                "error_code": result.get("error_code"),
                "retryable": bool(result.get("retryable", False)),
            })
    except Exception:
        pass

    return PublicToolResult(
        success=False,
        public_message="I could not check that just now. A Ride Electric team member can follow it up.",
        error_code="hubtiger_tool_error",
        retryable=True,
    )


async def run_read(request: Request, tool_key: str, payload: Any) -> PublicToolResult:
    require_tool_auth(request)
    return await call_existing_hubtiger(READ_TOOLS[tool_key], payload)


async def run_write(request: Request, tool_key: str, payload: Any) -> PublicToolResult:
    require_tool_auth(request)
    if not is_read_write():
        return read_only_block()
    return await call_existing_hubtiger(WRITE_TOOLS[tool_key], payload)


@router.post("/booking_availability", response_model=PublicToolResult)
async def booking_availability(request: Request, payload: BookingAvailabilityIn) -> PublicToolResult:
    return await run_read(request, "booking_availability", payload)


@router.post("/job_search", response_model=PublicToolResult)
async def job_search(request: Request, payload: JobSearchIn) -> PublicToolResult:
    return await run_read(request, "job_search", payload)


@router.post("/job_get", response_model=PublicToolResult)
async def job_get(request: Request, payload: JobGetIn) -> PublicToolResult:
    return await run_read(request, "job_get", payload)


@router.post("/products_search", response_model=PublicToolResult)
async def products_search(request: Request, payload: ProductSearchIn) -> PublicToolResult:
    return await run_read(request, "products_search", payload)


@router.post("/quote_preview", response_model=PublicToolResult)
async def quote_preview(request: Request, payload: QuotePreviewIn) -> PublicToolResult:
    return await run_read(request, "quote_preview", payload)


@router.post("/booking_create", response_model=PublicToolResult)
async def booking_create(request: Request, payload: BookingCreateIn) -> PublicToolResult:
    return await run_write(request, "booking_create", payload)


@router.post("/job_note_add", response_model=PublicToolResult)
async def job_note_add(request: Request, payload: JobNoteAddIn) -> PublicToolResult:
    return await run_write(request, "job_note_add", payload)


@router.post("/quote_add_line_item", response_model=PublicToolResult)
async def quote_add_line_item(request: Request, payload: QuoteAddLineItemIn) -> PublicToolResult:
    return await run_write(request, "quote_add_line_item", payload)


@router.post("/quote_request_approval_sms", response_model=PublicToolResult)
async def quote_request_approval_sms(request: Request, payload: QuoteApprovalIn) -> PublicToolResult:
    return await run_write(request, "quote_request_approval_sms", payload)


@router.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "elevenlabs_hubtiger_facade",
        "access_mode": os.getenv("HUBTIGER_TOOL_ACCESS", "read_only"),
        "auth_configured": bool(os.getenv("ELEVENLABS_HUBTIGER_WEBHOOK_SECRET", "").strip()),
    }
