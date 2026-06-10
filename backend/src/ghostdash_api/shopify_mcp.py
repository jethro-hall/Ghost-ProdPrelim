"""Shopify Admin GraphQL sidecar (shopify-mcp) client — server-side only."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from ghostdash_api.schemas import PublicToolResult
from ghostdash_api.settings import get_settings


@dataclass
class ShopifyMcpCallResult:
    success: bool
    operation: str
    message: str
    data: dict[str, Any]
    blocked: bool = False


def sanitize_shopify_public_data(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): sanitize_shopify_public_data(v) for k, v in value.items() if str(k).lower() not in {"accesstoken", "access_token", "authorization"}}
    if isinstance(value, list):
        return [sanitize_shopify_public_data(v) for v in value]
    return value


async def call_shopify_mcp(*, operation: str, payload: dict[str, Any] | None, trace_id: str) -> ShopifyMcpCallResult:
    settings = get_settings()
    base_url = str(settings.shopify_mcp_url or "").strip().rstrip("/")
    if not base_url:
        return ShopifyMcpCallResult(
            success=False,
            operation=operation,
            message="Shopify MCP URL is not configured. Set SHOPIFY_MCP_URL for this environment.",
            data={"configured": False, "error_code": "shopify_mcp_url_missing"},
        )
    timeout_ms = max(500, int(settings.shopify_mcp_timeout_ms or 15000))
    timeout_s = timeout_ms / 1000.0
    body = {"operation": operation, "payload": dict(payload or {}), "trace_id": trace_id}
    headers = {"Content-Type": "application/json", "X-Trace-Id": trace_id}
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            response = await client.post(f"{base_url}/execute", json=body, headers=headers)
    except httpx.TimeoutException:
        return ShopifyMcpCallResult(
            success=False,
            operation=operation,
            message="Shopify MCP request timed out.",
            data={"error_code": "shopify_mcp_timeout"},
        )
    except httpx.RequestError:
        return ShopifyMcpCallResult(
            success=False,
            operation=operation,
            message="Could not reach the Shopify MCP service.",
            data={"error_code": "shopify_mcp_unreachable"},
        )
    try:
        payload_json = response.json() if response.content else {}
    except ValueError:
        return ShopifyMcpCallResult(
            success=False,
            operation=operation,
            message="Shopify MCP returned an invalid response.",
            data={"status_code": response.status_code},
        )
    if not isinstance(payload_json, dict):
        return ShopifyMcpCallResult(
            success=False,
            operation=operation,
            message="Shopify MCP returned an unexpected response shape.",
            data={},
        )
    ok = bool(payload_json.get("ok", False))
    message = str(payload_json.get("message") or ("Shopify call completed." if ok else "Shopify call failed."))
    op_out = str(payload_json.get("operation") or operation).strip() or operation
    data = payload_json.get("data")
    if not isinstance(data, dict):
        data = {}
    return ShopifyMcpCallResult(
        success=ok,
        operation=op_out,
        message=message,
        data=sanitize_shopify_public_data(data) if isinstance(data, dict) else {},
    )


def to_public_shopify_tool_result(result: ShopifyMcpCallResult) -> PublicToolResult:
    return PublicToolResult(
        success=result.success,
        blocked=result.blocked,
        message=result.message,
        operation=result.operation,
        data=sanitize_shopify_public_data(result.data) if isinstance(result.data, dict) else {},
    )
