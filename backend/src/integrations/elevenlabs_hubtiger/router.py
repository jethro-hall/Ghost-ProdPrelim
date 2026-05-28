"""ElevenLabs → GhostDash HubTiger tool bridge. Authenticated; returns PublicToolResult only."""

from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, Request

from ghostdash_api.hubtiger_mcp import call_hubtiger_mcp, to_public_tool_result
from ghostdash_api.schemas import HubTigerTestRequest, PublicToolResult
from ghostdash_api.voice_ingress import _check_voice_auth

router = APIRouter(prefix="/agent/integrations/elevenlabs/hubtiger", tags=["elevenlabs-hubtiger"])


@router.post("/tool", response_model=PublicToolResult)
async def elevenlabs_hubtiger_tool(
    body: HubTigerTestRequest,
    request: Request,
) -> PublicToolResult:
    """Run a HubTiger diagnostics operation for ElevenLabs client tools. Uses APP_VOICE_INGRESS_SECRET (same as voice LLM)."""
    _check_voice_auth(request)
    trace_id = str(getattr(request.state, "trace_id", "") or "") or uuid4().hex
    raw = await call_hubtiger_mcp(
        operation=str(body.operation),
        payload=body.payload,
        trace_id=trace_id,
    )
    return to_public_tool_result(raw)
