from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from .models import RuntimeDefaultRecord
from .settings import get_settings

settings = get_settings()
RUNTIME_DEFAULTS_KEY = "chat_defaults"


@dataclass(slots=True)
class PdfIngestionConfig:
    chunk_size: int
    chunk_overlap: int
    sentence_window: int
    top_k: int
    parse_lane_policy: str
    rerank_enabled: bool


def default_runtime_defaults() -> dict[str, object]:
    return {
        "chat_api_mode": "responses",
        "pdf_chunk_size": settings.app_pdf_chunk_size,
        "pdf_chunk_overlap": settings.app_pdf_chunk_overlap,
        "pdf_sentence_window": settings.app_pdf_sentence_window,
        "pdf_top_k": settings.app_pdf_top_k,
        "pdf_parse_lane_policy": settings.app_pdf_parse_lane_policy,
        "pdf_rerank_enabled": False,
    }


def merge_runtime_defaults(values: dict | None) -> dict[str, object]:
    merged = default_runtime_defaults()
    if values:
        merged.update(values)
    return merged


def ensure_runtime_defaults(session: Session) -> RuntimeDefaultRecord:
    record = session.get(RuntimeDefaultRecord, RUNTIME_DEFAULTS_KEY)
    merged = merge_runtime_defaults(record.value_json if record is not None else None)
    if record is None:
        record = RuntimeDefaultRecord(key=RUNTIME_DEFAULTS_KEY, value_json=merged)
        session.add(record)
        session.commit()
        session.refresh(record)
        return record

    if record.value_json != merged:
        record.value_json = merged
        session.commit()
        session.refresh(record)
    return record


def get_runtime_defaults(session: Session) -> dict[str, object]:
    return dict(ensure_runtime_defaults(session).value_json)


def get_pdf_ingestion_config(session: Session) -> PdfIngestionConfig:
    values = get_runtime_defaults(session)
    return PdfIngestionConfig(
        chunk_size=int(values.get("pdf_chunk_size", settings.app_pdf_chunk_size)),
        chunk_overlap=int(values.get("pdf_chunk_overlap", settings.app_pdf_chunk_overlap)),
        sentence_window=int(values.get("pdf_sentence_window", settings.app_pdf_sentence_window)),
        top_k=int(values.get("pdf_top_k", settings.app_pdf_top_k)),
        parse_lane_policy=str(values.get("pdf_parse_lane_policy", settings.app_pdf_parse_lane_policy)),
        rerank_enabled=bool(values.get("pdf_rerank_enabled", False)),
    )


def resolve_query_top_k(session: Session, requested_top_k: int | None) -> int:
    if requested_top_k is not None and requested_top_k > 0:
        return requested_top_k
    values = get_runtime_defaults(session)
    return int(values.get("pdf_top_k", settings.app_pdf_top_k))
