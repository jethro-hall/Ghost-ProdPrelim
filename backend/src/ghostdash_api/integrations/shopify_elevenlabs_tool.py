"""ElevenLabs Shopify public API surface under /api (webhook-friendly)."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from httpx import ConnectError, RequestError, TimeoutException

from ghostdash_api.schemas import PublicToolResult
from ghostdash_api.settings import get_settings
from ghostdash_api.voice_ingress import _check_shopify_voice_auth

from .shopify_elevenlabs_schemas import ShopifyElevenLabsToolRequest
from integrations.elevenlabs_shopify.router import run_elevenlabs_shopify_tool_request

router = APIRouter(prefix="/api/elevenlabs/shopify", tags=["elevenlabs-shopify"])


@router.get("/health")
async def shopify_health(request: Request) -> JSONResponse:
    _check_shopify_voice_auth(request)
    settings = get_settings()
    mcp_url = str(settings.shopify_mcp_url or "").strip().rstrip("/")
    health_ms = max(250, int(settings.shopify_mcp_health_timeout_ms or 4000))
    if not mcp_url:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "service": "elevenlabs-shopify",
                "ready": False,
                "error_code": "shopify_mcp_url_missing",
                "message": "Shopify MCP URL is not configured. Set SHOPIFY_MCP_URL for this environment.",
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
                    "service": "elevenlabs-shopify",
                    "ready": False,
                    "error_code": "shopify_mcp_unhealthy",
                    "message": "The Shopify MCP health check returned an error.",
                },
            )
        body = response.json() if response.content else {}
        configured = bool(body.get("shopify_configured"))
        return JSONResponse(
            status_code=200,
            content={
                "ok": True,
                "service": "elevenlabs-shopify",
                "ready": True,
                "shopify_mcp_configured": configured,
                "health_check_timeout_ms": health_ms,
            },
        )
    except TimeoutException:
        return JSONResponse(
            status_code=504,
            content={
                "ok": False,
                "service": "elevenlabs-shopify",
                "ready": False,
                "error_code": "shopify_mcp_health_timeout",
                "message": f"The Shopify MCP health check timed out after {health_ms} ms.",
                "timeout_ms": health_ms,
            },
        )
    except ConnectError:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "service": "elevenlabs-shopify",
                "ready": False,
                "error_code": "shopify_mcp_unreachable",
                "message": "Could not open a connection to the Shopify MCP service.",
            },
        )
    except RequestError:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "service": "elevenlabs-shopify",
                "ready": False,
                "error_code": "shopify_mcp_request_failed",
                "message": "The Shopify MCP health request failed before a response was received.",
            },
        )
    except Exception:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "service": "elevenlabs-shopify",
                "ready": False,
                "error_code": "shopify_mcp_health_error",
                "message": "An unexpected error occurred while checking Shopify MCP health.",
            },
        )


@router.post("/tool", response_model=PublicToolResult)
async def shopify_tool(body: ShopifyElevenLabsToolRequest, request: Request) -> PublicToolResult:
    return await run_elevenlabs_shopify_tool_request(body=body, request=request)
