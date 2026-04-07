from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, Float, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)


class ConnectionRecord(TimestampMixin, Base):
    __tablename__ = 'connections'

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    provider: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(64))
    api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    base_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    chat_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    embedding_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)

    @property
    def masked_api_key(self) -> str | None:
        if not self.api_key:
            return None
        return f"***{self.api_key[-4:]}"


class DocumentRecord(TimestampMixin, Base):
    __tablename__ = 'documents'

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    corpus: Mapped[str] = mapped_column(String(128), index=True)
    filename: Mapped[str] = mapped_column(String(256))
    source_path: Mapped[str] = mapped_column(Text, unique=True)
    policy_lane: Mapped[str] = mapped_column(String(32), default='local')
    parse_lane: Mapped[str | None] = mapped_column(String(32), nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default='uploaded')
    metadata_json: Mapped[str] = mapped_column(Text, default='{}')
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    @property
    def meta(self) -> dict:
        return json.loads(self.metadata_json or '{}')


class TaskRecord(TimestampMixin, Base):
    __tablename__ = 'tasks'

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: str(uuid4()))
    task_type: Mapped[str] = mapped_column(String(64), default='full_sync')
    status: Mapped[str] = mapped_column(String(32), default='pending')
    current_step: Mapped[str] = mapped_column(String(64), default='queued')
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    payload_json: Mapped[str] = mapped_column(Text, default='{}')
    result_json: Mapped[str] = mapped_column(Text, default='{}')
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    @property
    def payload(self) -> dict:
        return json.loads(self.payload_json or '{}')

    @property
    def result(self) -> dict:
        return json.loads(self.result_json or '{}')
