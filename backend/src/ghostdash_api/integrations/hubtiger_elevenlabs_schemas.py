from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class HubTigerCustomerByPhoneRequest(BaseModel):
    phone: str = Field(min_length=6, max_length=32)

    @field_validator("phone", mode="before")
    @classmethod
    def _trim_phone(cls, value: str | None) -> str:
        trimmed = str(value or "").strip()
        if not trimmed:
            raise ValueError("`phone` is required.")
        return trimmed


class HubTigerElevenLabsLookupRequest(BaseModel):
    """Public request contract for ElevenLabs HubTiger tool."""

    function: str = Field(default="lookup_job", max_length=64)
    cache_mode: str | None = Field(default=None, max_length=32)
    phone: str | None = Field(default=None, max_length=64)
    first_name: str | None = Field(default=None, max_length=128)
    last_name: str | None = Field(default=None, max_length=128)
    job_id: str | None = Field(default=None, max_length=64)
    job_card_no: str | None = Field(default=None, max_length=64)
    start_date: str | None = Field(default=None, max_length=64)
    end_date: str | None = Field(default=None, max_length=64)
    store: str | None = Field(default=None, max_length=128)
    date: str | None = Field(default=None, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator(
        "function",
        "cache_mode",
        "phone",
        "first_name",
        "last_name",
        "job_id",
        "job_card_no",
        "start_date",
        "end_date",
        "store",
        "date",
        mode="before",
    )
    @classmethod
    def _trim_optional_fields(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = str(value).strip()
        return trimmed or None

    @field_validator("payload", mode="before")
    @classmethod
    def _validate_payload(cls, value: Any) -> dict[str, Any]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("`payload` must be an object.")
        if len(value) > 24:
            raise ValueError("`payload` has too many fields.")
        return value
