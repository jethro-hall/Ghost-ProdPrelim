"""ElevenLabs → GhostDash HubTiger tool bridge. Authenticated; returns PublicToolResult only."""

from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request

from ghostdash_api.hubtiger_mcp import call_hubtiger_mcp, normalize_hubtiger_tool_call, to_public_tool_result
from ghostdash_api.schemas import ElevenLabsHubTigerToolRequest, PublicToolResult
from ghostdash_api.voice_ingress import _check_hubtiger_voice_auth

router = APIRouter(prefix="/agent/integrations/elevenlabs/hubtiger", tags=["elevenlabs-hubtiger"])


@router.get("", summary="ElevenLabs HubTiger bridge discovery")
async def elevenlabs_hubtiger_discovery() -> dict[str, str]:
    """Return canonical tool URL. ElevenLabs URL validation and curl probes often hit this path without `/tool`, which would otherwise 404."""
    return {
        "service": "ghostdash-elevenlabs-hubtiger",
        "post_path": "/agent/integrations/elevenlabs/hubtiger/tool",
        "method": "POST",
        "authentication": "Authorization: Bearer or X-Ghost-Voice-Key: <APP_VOICE_INGRESS_SECRET>",
        "content_type": "application/json",
        "body_shape": '{"function":"job_lookup","date":"2026-04-29","store":"brisbane","customer":{"phone":"0412345678"}}',
        "api_alias_booking_availability": "/api/elevenlabs/hubtiger/booking_availability",
        "api_alias_customer_by_phone": "/api/elevenlabs/hubtiger/customer-by-phone",
    }


async def run_elevenlabs_hubtiger_tool_request(
    *,
    body: ElevenLabsHubTigerToolRequest,
    request: Request,
) -> PublicToolResult:
    """Shared canonical HubTiger tool executor for both /agent and /api surfaces."""
    _check_hubtiger_voice_auth(request)
    trace_id = str(getattr(request.state, "trace_id", "") or "") or uuid4().hex
    try:
        operation, payload = normalize_hubtiger_tool_call(
            function=body.function,
            operation=body.operation,
            cache_mode=body.cache_mode,
            payload=body.payload,
            store=body.store,
            date=body.date,
            start_date=body.start_date,
            end_date=body.end_date,
            customer=body.customer.model_dump(exclude_none=True) if body.customer else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    raw = await call_hubtiger_mcp(
        operation=operation,
        payload=payload,
        trace_id=trace_id,
    )
    return to_public_tool_result(raw)


@router.post("/tool", response_model=PublicToolResult)
async def elevenlabs_hubtiger_tool(
    body: ElevenLabsHubTigerToolRequest,
    request: Request,
) -> PublicToolResult:
    """Run a HubTiger diagnostics operation for ElevenLabs client tools. Uses APP_VOICE_INGRESS_SECRET (same as voice LLM)."""
    return await run_elevenlabs_hubtiger_tool_request(
        body=body,
        request=request,
    )
