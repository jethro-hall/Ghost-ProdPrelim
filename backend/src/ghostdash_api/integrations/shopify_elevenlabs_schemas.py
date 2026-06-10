"""Pydantic models for POST /api/elevenlabs/shopify/tool."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class ShopifyElevenLabsToolRequest(BaseModel):
    """ElevenLabs webhook body for Shopify read-only tools."""

    function: str = Field(
        ...,
        description="Canonical operation: connection_check | product_search (aliases: ping, shop_info, products_search).",
        min_length=1,
        max_length=64,
    )
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("function")
    @classmethod
    def strip_function(cls, v: str) -> str:
        return str(v or "").strip()


def canonical_shopify_function(name: str) -> str:
    key = str(name or "").strip().lower()
    if key in {"ping", "shop_info", "connection_check", "shop_ping"}:
        return "connection_check"
    if key in {"product_search", "products_search", "search_products"}:
        return "product_search"
    return key
