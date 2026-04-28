from __future__ import annotations

from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field


class PublicToolResult(BaseModel):
    success: bool
    public_message: str
    data: dict[str, Any] = Field(default_factory=dict)
    error_code: str | None = None
    retryable: bool = False


class BookingAvailabilityIn(BaseModel):
    store: Literal["brisbane", "newstead", "southport", "burleigh"]
    start_date: date
    end_date: date | None = None
    service_type_ids: list[int] = Field(default_factory=list)
    limit: int = Field(3, ge=1, le=10)


class JobSearchIn(BaseModel):
    search: str = Field(..., min_length=2, max_length=120)
    search_all_stores: bool = False
    limit: int = Field(5, ge=1, le=10)


class JobGetIn(BaseModel):
    jobcard_id: int = Field(..., ge=1)


class ProductSearchIn(BaseModel):
    query: str = Field(..., min_length=2, max_length=160)
    limit: int = Field(5, ge=1, le=10)


class QuotePreviewIn(BaseModel):
    query: str = Field(..., min_length=2, max_length=160)
    quantity: float = Field(1, gt=0, le=100)


class SlotIn(BaseModel):
    store: str
    date: str
    start_time: str
    end_time: str = ""
    duration_minutes: int = 0
    technician_id: int


class BookingCreateIn(BaseModel):
    store: Literal["brisbane", "newstead", "southport", "burleigh"]
    slot: SlotIn
    first_name: str = Field(..., min_length=1, max_length=80)
    last_name: str = Field(..., min_length=1, max_length=80)
    mobile: str = Field(..., min_length=8, max_length=30)
    email: str | None = Field(None, max_length=160)
    manufacturer: str = Field(..., min_length=1, max_length=80)
    model: str = Field(..., min_length=1, max_length=120)
    colour: str = Field("", max_length=80)
    serial_no: str | None = Field(None, max_length=120)
    service_type_ids: list[int] = Field(default_factory=list)
    is_first_service: bool = False
    notes: str = Field("", max_length=1500)
    idempotency_key: str | None = Field(None, max_length=160)


class JobNoteAddIn(BaseModel):
    jobcard_id: int = Field(..., ge=1)
    note: str = Field(..., min_length=1, max_length=1500)
    note_type: Literal["external", "internal"] = "external"


class QuoteAddLineItemIn(BaseModel):
    jobcard_id: int = Field(..., ge=1)
    invoice_id: int | None = Field(None, ge=1)
    product: dict[str, Any]
    quantity: float = Field(1, gt=0, le=100)
    discount: float = Field(0, ge=0, le=100)
    idempotency_key: str | None = Field(None, max_length=160)


class QuoteApprovalIn(BaseModel):
    jobcard_id: int = Field(..., ge=1)
    cyclist_id: int = Field(..., ge=1)
    jobcard_no: int | None = None
    message: str = Field("Ride Electric has updated your quote and needs your approval.", max_length=500)
