"""ElevenLabs → GhostDash Shopify tool bridge. Authenticated; returns PublicToolResult only."""

from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request

from ghostdash_api.integrations.shopify_elevenlabs_schemas import ShopifyElevenLabsToolRequest, canonical_shopify_function
from ghostdash_api.schemas import PublicToolResult
from ghostdash_api.shopify_mcp import call_shopify_mcp, to_public_shopify_tool_result
from ghostdash_api.voice_ingress import _check_shopify_voice_auth

router = APIRouter(prefix="/agent/integrations/elevenlabs/shopify", tags=["elevenlabs-shopify"])


@router.get("", summary="ElevenLabs Shopify bridge discovery")
async def elevenlabs_shopify_discovery() -> dict[str, str]:
    return {
        "service": "ghostdash-elevenlabs-shopify",
        "post_path": "/agent/integrations/elevenlabs/shopify/tool",
        "api_alias": "/api/elevenlabs/shopify/tool",
        "method": "POST",
        "authentication": "X-Ghost-Voice-Key or Authorization: Bearer with ELEVENLABS_SHOPIFY_WEBHOOK_SECRET (or APP_VOICE_INGRESS_SECRET)",
        "content_type": "application/json",
        "body_shape": '{"function":"connection_check","payload":{}}',
    }


async def run_elevenlabs_shopify_tool_request(
    *,
    body: ShopifyElevenLabsToolRequest,
    request: Request,
) -> PublicToolResult:
    """Shared executor for /api and /agent ElevenLabs Shopify surfaces."""
    _check_shopify_voice_auth(request)
    canonical = canonical_shopify_function(body.function)
    allowed = {"connection_check", "product_search"}
    if canonical not in allowed:
        raise HTTPException(
            status_code=422,
            detail=f"Supported functions: `connection_check`, `product_search`. Got `{body.function}`.",
        )
    trace_id = str(getattr(request.state, "trace_id", "") or "") or uuid4().hex
    raw = await call_shopify_mcp(
        operation=canonical,
        payload=dict(body.payload or {}),
        trace_id=trace_id,
    )
    return to_public_shopify_tool_result(raw)


@router.post("/tool", response_model=PublicToolResult)
async def elevenlabs_shopify_tool(
    body: ShopifyElevenLabsToolRequest,
    request: Request,
) -> PublicToolResult:
    return await run_elevenlabs_shopify_tool_request(body=body, request=request)
