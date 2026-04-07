from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from .runtime_profiles import (
    default_runtime_profile_payload,
    get_default_runtime_profile,
    runtime_defaults_view,
    update_runtime_defaults,
)
from .settings import get_settings

settings = get_settings()


@dataclass(slots=True)
class TextIngestionConfig:
    chunk_size: int
    chunk_overlap: int
    heading_aware: bool


@dataclass(slots=True)
class PdfIngestionConfig:
    chunk_size: int
    chunk_overlap: int
    sentence_window: int
    top_k: int
    parse_lane_policy: str
    rerank_enabled: bool


def default_runtime_defaults() -> dict[str, object]:
    payload = default_runtime_profile_payload()
    return {
        "chat_api_mode": payload["llm_config_json"]["api_mode"],
        "llm_model_id": payload["llm_config_json"]["model_id"],
        "embedding_model_id": payload["kb_config_json"]["embedding_model_id"],
        "default_corpora": list(payload["kb_config_json"]["default_corpora"]),
        "text_chunk_size": payload["retrieval_config_json"]["text_chunk_size"],
        "text_chunk_overlap": payload["retrieval_config_json"]["text_chunk_overlap"],
        "text_heading_aware": payload["retrieval_config_json"]["text_heading_aware"],
        "pdf_chunk_size": payload["retrieval_config_json"]["pdf_chunk_size"],
        "pdf_chunk_overlap": payload["retrieval_config_json"]["pdf_chunk_overlap"],
        "pdf_sentence_window": payload["retrieval_config_json"]["pdf_sentence_window"],
        "pdf_top_k": payload["retrieval_config_json"]["default_top_k"],
        "pdf_parse_lane_policy": payload["retrieval_config_json"]["pdf_parse_lane_policy"],
        "pdf_rerank_enabled": payload["retrieval_config_json"]["pdf_rerank_enabled"],
    }


def merge_runtime_defaults(values: dict | None) -> dict[str, object]:
    merged = default_runtime_defaults()
    if values:
        merged.update(values)
    return merged


def get_runtime_defaults(session: Session) -> dict[str, object]:
    return dict(runtime_defaults_view(get_default_runtime_profile(session)))


def save_runtime_defaults(session: Session, values: dict[str, object]) -> dict[str, object]:
    profile = update_runtime_defaults(session, values)
    return runtime_defaults_view(profile)


def get_text_ingestion_config(session: Session) -> TextIngestionConfig:
    values = get_runtime_defaults(session)
    return TextIngestionConfig(
        chunk_size=int(values.get("text_chunk_size", settings.app_chunk_size)),
        chunk_overlap=int(values.get("text_chunk_overlap", settings.app_chunk_overlap)),
        heading_aware=bool(values.get("text_heading_aware", True)),
    )


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


def resolve_query_top_k(session: Session, requested_top_k: int | None, *, runtime_profile=None) -> int:
    if requested_top_k is not None and requested_top_k > 0:
        return requested_top_k
    if runtime_profile is None:
        values = get_runtime_defaults(session)
    else:
        values = runtime_defaults_view(runtime_profile)
    return int(values.get("pdf_top_k", settings.app_pdf_top_k))
