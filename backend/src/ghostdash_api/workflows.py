from __future__ import annotations

import hashlib
import json
import mimetypes
import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from llama_index.core.workflow import Event, StartEvent, StopEvent, Workflow, step
from sqlalchemy import delete, select

from .database import SessionLocal
from .ingest import (
    PDF_ARTIFACT_TYPE,
    PDF_ORIGINAL_TEXT_METADATA_KEY,
    PDF_WINDOW_METADATA_KEY,
    build_pdf_nodes,
    detect_section_title,
    estimate_token_count,
    extract_pdf_documents,
    extract_spreadsheet_structure,
    extract_text_cloud,
    extract_text_local,
)
from .models import (
    DocumentRecord,
    DocumentVersionRecord,
    IngestionRunRecord,
    RetrievalArtifactRecord,
    WorkbookArtifactRecord,
    WorkbookRowRecord,
    WorkbookSheetRecord,
    WorkbookTableRecord,
)
from .qdrant_store import delete_document_vectors, search_vectors, upsert_retrieval_artifacts
from .runtime import embed_texts, get_active_connection
from .runtime_defaults import get_pdf_ingestion_config, get_text_ingestion_config
from .runtime_profiles import get_default_runtime_profile
from .settings import get_settings
from .telemetry import log_instant_event

settings = get_settings()
SYNC_STEPS = ("queued", "parse_structure", "index_retrieval", "finalize")
QDRANT_UPSERT_MAX_BYTES = 24 * 1024 * 1024
QDRANT_UPSERT_MAX_POINTS = 96
QDRANT_PAYLOAD_TEXT_MAX_CHARS = 8000
QDRANT_EXCLUDED_METADATA_KEYS = frozenset({PDF_ORIGINAL_TEXT_METADATA_KEY, PDF_WINDOW_METADATA_KEY})
DOCUMENT_EXPANSION_LIMIT_MULTIPLIER = 3
DOCUMENT_EXPANSION_LIMIT_FLOOR = 8
DOCUMENT_EXPANSION_LIMIT_CAP = 18
DOCUMENT_DOMINANCE_MIN_HITS = 3
DOCUMENT_DOMINANCE_MIN_SHARE = 0.6
DOCUMENT_DOMINANCE_MIN_SCORE_SHARE = 0.65
DOCUMENT_DOMINANCE_MIN_GAP = 2
ODOO_COMPANY_ID_PATTERN = re.compile(r"\bcompany(?:[_\s-]?id)?\s*(?:=|:|#)?\s*(\d+)\b", re.IGNORECASE)
ODOO_COMPANY_LIST_PATTERN = re.compile(r"\bcompan(?:y|ies)(?:[_\s-]?id)?s?\b([^\n\r]{0,80})", re.IGNORECASE)
ODOO_OPERATION_PREVIEW_TERMS = (
    "do not execute",
    "don't execute",
    "would use",
    "what operation",
    "what payload",
    "exact operation",
    "exact `odoo_primary` operation",
    "exact odoo_primary operation",
    "json-rpc equivalent",
)
ODOO_MONTH_NAME_ALIASES = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
ODOO_MONTH_TOKEN_PATTERN = re.compile(
    r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b",
    re.IGNORECASE,
)
ODOO_COMPANY_NAME_HINTS = {
    "retail": ("retail",),
    "burleigh": ("burleigh",),
    "brisbane": ("brisbane",),
}

# PostgreSQL rejects bound-parameter lists larger than ~65535; large IN (...) on row-derived
# id lists must be chunked (see find_structured_candidates).
_PG_IN_CHUNK = 8000


def _fetch_workbook_tables_by_ids(session, table_ids: set[str]) -> dict[str, WorkbookTableRecord]:
    if not table_ids:
        return {}
    tables: dict[str, WorkbookTableRecord] = {}
    ids = list(table_ids)
    for i in range(0, len(ids), _PG_IN_CHUNK):
        chunk = ids[i : i + _PG_IN_CHUNK]
        for table in session.scalars(select(WorkbookTableRecord).where(WorkbookTableRecord.id.in_(chunk))):
            tables[table.id] = table
    return tables


def _fetch_workbook_sheets_by_ids(session, sheet_ids: set[str]) -> dict[str, WorkbookSheetRecord]:
    if not sheet_ids:
        return {}
    sheets: dict[str, WorkbookSheetRecord] = {}
    ids = list(sheet_ids)
    for i in range(0, len(ids), _PG_IN_CHUNK):
        chunk = ids[i : i + _PG_IN_CHUNK]
        for sheet in session.scalars(select(WorkbookSheetRecord).where(WorkbookSheetRecord.id.in_(chunk))):
            sheets[sheet.id] = sheet
    return sheets


class DocumentsPreparedEvent(Event):
    run_id: str
    trace_id: str
    document_ids: list[str]


class RetrievalPreparedEvent(Event):
    run_id: str
    trace_id: str
    document_ids: list[str]


def start_event_value(ev: StartEvent, key: str, default: Any = None) -> Any:
    return getattr(ev, "_data", {}).get(key, default)


def iso_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC).isoformat()
    return value.astimezone(UTC).isoformat()


def _add_months(value: date, months: int) -> date:
    zero_indexed = (value.year * 12) + (value.month - 1) + months
    year = zero_indexed // 12
    month = (zero_indexed % 12) + 1
    return value.replace(year=year, month=month, day=1)


def build_document_base_metadata(document: DocumentRecord, version: DocumentVersionRecord) -> dict[str, Any]:
    return {
        "file_path": document.source_path,
        "ingestion_date": iso_timestamp(version.created_at),
        "corpus": document.corpus,
        "entity_type": "document_chunk",
        "entity_hints": [],
        "relation_hints": [],
        "source_id": document.id,
        "content_hash": version.version_hash,
        "document_version_id": version.id,
        "filename": document.filename,
    }


def build_retrieval_metadata(
    *,
    document: DocumentRecord,
    version: DocumentVersionRecord,
    artifact_type: str,
    parse_lane: str,
    extra_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metadata = {
        **build_document_base_metadata(document, version),
        "artifact_type": artifact_type,
        "parse_lane": parse_lane,
        "source_path": document.source_path,
        "source_kind": document.source_kind,
    }
    if extra_metadata:
        metadata.update({key: value for key, value in extra_metadata.items() if value is not None})
    return metadata


def build_qdrant_payload(document: DocumentRecord, artifact: RetrievalArtifactRecord) -> dict[str, Any]:
    metadata = dict(artifact.metadata_json or {})
    payload_metadata = {
        key: value
        for key, value in metadata.items()
        if key not in QDRANT_EXCLUDED_METADATA_KEYS
    }
    return {
        "document_id": document.id,
        "document_version_id": metadata.get("document_version_id"),
        "filename": document.filename,
        "corpus": document.corpus,
        "artifact_type": artifact.artifact_type,
        "chunk_index": metadata.get("chunk_index"),
        "source_path": document.source_path,
        "content_hash": metadata.get("content_hash"),
        "page_start": metadata.get("page_start"),
        "page_end": metadata.get("page_end"),
        "section_title": metadata.get("section_title"),
        "section_path": metadata.get("section_path"),
        "heading_level": metadata.get("heading_level"),
        "parse_lane": metadata.get("parse_lane"),
        "text": metadata.get(PDF_WINDOW_METADATA_KEY) or artifact.text,
        "metadata": payload_metadata,
    }


def estimate_qdrant_point_bytes(payload: dict[str, Any], vector: list[float]) -> int:
    normalized_payload = dict(payload)
    normalized_payload["text"] = str(normalized_payload.get("text", ""))[:QDRANT_PAYLOAD_TEXT_MAX_CHARS]
    point = {
        "id": "00000000-0000-0000-0000-000000000000",
        "payload": normalized_payload,
        "vector": vector,
    }
    return len(json.dumps(point, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8"))


def build_qdrant_upsert_batches(
    payloads: list[dict[str, Any]],
    vectors: list[list[float]],
) -> list[tuple[list[dict[str, Any]], list[list[float]], int]]:
    batches: list[tuple[list[dict[str, Any]], list[list[float]], int]] = []
    batch_payloads: list[dict[str, Any]] = []
    batch_vectors: list[list[float]] = []
    batch_bytes = 0

    for payload, vector in zip(payloads, vectors, strict=True):
        point_bytes = estimate_qdrant_point_bytes(payload, vector)
        exceeds_batch = (
            batch_payloads
            and (
                len(batch_payloads) >= QDRANT_UPSERT_MAX_POINTS
                or batch_bytes + point_bytes > QDRANT_UPSERT_MAX_BYTES
            )
        )
        if exceeds_batch:
            batches.append((batch_payloads, batch_vectors, batch_bytes))
            batch_payloads = []
            batch_vectors = []
            batch_bytes = 0

        batch_payloads.append(payload)
        batch_vectors.append(vector)
        batch_bytes += point_bytes

    if batch_payloads:
        batches.append((batch_payloads, batch_vectors, batch_bytes))
    return batches


def build_run_failure_message(*, parse_failed: int, index_failed: int) -> str | None:
    total_failed = parse_failed + index_failed
    if total_failed == 0:
        return None
    if parse_failed and index_failed:
        return (
            f"{total_failed} document(s) failed during ingestion "
            f"({parse_failed} during parsing, {index_failed} during indexing)"
        )
    if index_failed:
        return f"{index_failed} document(s) failed during indexing"
    return f"{parse_failed} document(s) failed during parsing"


def bounded_window_text(text: str, *, chunk_size: int, chunk_overlap: int) -> str:
    max_chars = max(chunk_size + chunk_overlap, chunk_size)
    if len(text) <= max_chars:
        return text
    clipped = text[:max_chars].rsplit(" ", 1)[0].strip()
    return clipped or text[:max_chars].strip()


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks: list[str] = []
    start = 0
    size = len(text)
    while start < size:
        end = min(size, start + chunk_size)
        if end < size:
            search_start = min(size, start + max(chunk_size // 2, 1))
            boundary_candidates = (
                ("\n\n", 0),
                ("\n", 0),
                (". ", 1),
                ("? ", 1),
                ("! ", 1),
                ("; ", 1),
                (", ", 1),
                (" ", 0),
            )
            for delimiter, keep_chars in boundary_candidates:
                snapped = text.rfind(delimiter, search_start, end)
                if snapped > start:
                    end = snapped + keep_chars
                    break
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= size:
            break
        start = max(0, end - overlap)
        while start < size and text[start].isspace():
            start += 1
    return chunks


def _is_structured_heading(line: str, *, previous_line: str | None, next_line: str | None) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if re.match(r"^\s{0,3}#{1,6}\s+\S", stripped):
        return True
    prev_blank = previous_line is None or not previous_line.strip()
    next_blank = next_line is None or not next_line.strip()
    if not (prev_blank or next_blank):
        return False
    return (
        len(stripped) <= 100
        and stripped.upper() == stripped
        and any(char.isalpha() for char in stripped)
    )


def _extract_heading_descriptor(
    line: str,
    *,
    previous_line: str | None,
    next_line: str | None,
) -> tuple[str, int] | None:
    stripped = line.strip()
    markdown_match = re.match(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$", stripped)
    if markdown_match:
        return markdown_match.group(2).strip()[:200], len(markdown_match.group(1))
    if _is_structured_heading(stripped, previous_line=previous_line, next_line=next_line):
        return (detect_section_title(stripped) or stripped[:200], 1)
    return None


def build_text_sections(text: str, *, preserve_headings: bool = True) -> list[dict[str, Any]]:
    normalized = text.strip()
    if not normalized:
        return []
    if not preserve_headings:
        detected_title = detect_section_title(normalized)
        return [
            {
                "section_title": detected_title,
                "section_path": detected_title,
                "heading_level": None,
                "text": normalized,
            }
        ]

    lines = normalized.splitlines()
    sections: list[dict[str, Any]] = []
    current_lines: list[str] = []
    current_title: str | None = None
    current_path: str | None = None
    current_heading_level: int | None = None
    heading_stack: list[str | None] = []

    def flush_section() -> None:
        body = "\n".join(current_lines).strip()
        if not body:
            return
        sections.append(
            {
                "section_title": current_title or detect_section_title(body),
                "section_path": current_path or current_title or detect_section_title(body),
                "heading_level": current_heading_level,
                "text": body,
            }
        )

    for idx, line in enumerate(lines):
        previous_line = lines[idx - 1] if idx > 0 else None
        next_line = lines[idx + 1] if idx + 1 < len(lines) else None
        heading = _extract_heading_descriptor(line, previous_line=previous_line, next_line=next_line)
        if heading:
            heading_title, heading_level = heading
            if current_lines:
                flush_section()
                current_lines = []
            while len(heading_stack) < heading_level:
                heading_stack.append(None)
            heading_stack = heading_stack[:heading_level]
            heading_stack[heading_level - 1] = heading_title
            current_title = heading_title
            current_heading_level = heading_level
            current_path = " > ".join(title for title in heading_stack if title)
        current_lines.append(line)

    flush_section()
    if sections:
        return sections
    detected_title = detect_section_title(normalized)
    return [
        {
            "section_title": detected_title,
            "section_path": detected_title,
            "heading_level": None,
            "text": normalized,
        }
    ]


def build_text_retrieval_chunks(
    text: str,
    *,
    chunk_size: int,
    overlap: int,
    preserve_headings: bool,
) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for section_index, section in enumerate(build_text_sections(text, preserve_headings=preserve_headings)):
        section_title = section.get("section_title")
        section_path = section.get("section_path")
        heading_level = section.get("heading_level")
        section_text = str(section.get("text") or "").strip()
        if not section_text:
            continue
        for section_chunk_index, chunk in enumerate(chunk_text(section_text, chunk_size, overlap)):
            chunks.append(
                {
                    "text": chunk,
                    "section_title": section_title,
                    "section_path": section_path,
                    "heading_level": heading_level,
                    "section_index": section_index,
                    "section_chunk_index": section_chunk_index,
                }
            )
    return chunks


def normalize_header(value: str, idx: int) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", value.strip().lower()).strip("_")
    return cleaned or f"column_{idx + 1}"


def row_search_text(row_json: dict[str, Any]) -> str:
    return " | ".join(f"{key}: {value}" for key, value in row_json.items())


def build_row_artifact_text(*, filename: str, sheet_name: str, table_name: str, row_index: int, row_json: dict[str, Any]) -> str:
    joined = ", ".join(f"{key}={value}" for key, value in row_json.items())
    return f"Workbook {filename} | Sheet {sheet_name} | Table {table_name} | Row {row_index}: {joined}"


def clear_document_state(session, document_id: str) -> None:
    workbook_ids = list(
        session.scalars(
            select(WorkbookArtifactRecord.id).where(WorkbookArtifactRecord.document_id == document_id)
        )
    )
    sheet_ids = list(
        session.scalars(
            select(WorkbookSheetRecord.id).where(WorkbookSheetRecord.workbook_artifact_id.in_(workbook_ids))
        )
    ) if workbook_ids else []
    table_ids = list(
        session.scalars(
            select(WorkbookTableRecord.id).where(WorkbookTableRecord.workbook_sheet_id.in_(sheet_ids))
        )
    ) if sheet_ids else []
    if table_ids:
        session.execute(delete(WorkbookRowRecord).where(WorkbookRowRecord.workbook_table_id.in_(table_ids)))
        session.execute(delete(WorkbookTableRecord).where(WorkbookTableRecord.id.in_(table_ids)))
    if sheet_ids:
        session.execute(delete(WorkbookSheetRecord).where(WorkbookSheetRecord.id.in_(sheet_ids)))
    if workbook_ids:
        session.execute(delete(WorkbookArtifactRecord).where(WorkbookArtifactRecord.id.in_(workbook_ids)))
    session.execute(delete(RetrievalArtifactRecord).where(RetrievalArtifactRecord.document_id == document_id))


def persist_document_version(session, document: DocumentRecord) -> DocumentVersionRecord:
    path = Path(document.source_path)
    payload = path.read_bytes()
    content_hash = hashlib.sha256(payload).hexdigest()
    version = session.scalar(
        select(DocumentVersionRecord).where(
            DocumentVersionRecord.document_id == document.id,
            DocumentVersionRecord.version_hash == content_hash,
        )
    )
    if version is None:
        version = DocumentVersionRecord(
            document_id=document.id,
            version_hash=content_hash,
            storage_path=document.source_path,
            size_bytes=len(payload),
            mime_type=document.mime_type,
            source_kind=document.source_kind,
            metadata_json={"filename": document.filename},
        )
        session.add(version)
        session.flush()
    document.content_hash = content_hash
    document.latest_version_id = version.id
    return version


def persist_workbook_structure(
    session,
    *,
    document: DocumentRecord,
    version: DocumentVersionRecord,
    parse_lane: str,
    structure: dict[str, Any],
) -> tuple[int, int, list[RetrievalArtifactRecord]]:
    workbook = WorkbookArtifactRecord(
        document_id=document.id,
        document_version_id=version.id,
        filename=document.filename,
        sheet_count=structure.get("sheet_count", 0),
        metadata_json={"kind": structure.get("kind", "workbook")},
    )
    session.add(workbook)
    session.flush()

    table_count = 0
    row_count = 0
    retrieval_artifacts: list[RetrievalArtifactRecord] = []

    for sheet_idx, sheet in enumerate(structure.get("sheets", []), start=1):
        rows = sheet.get("rows", [])
        sheet_record = WorkbookSheetRecord(
            workbook_artifact_id=workbook.id,
            name=sheet.get("title", f"Sheet {sheet_idx}"),
            ordinal=sheet_idx,
            row_count=max(len(rows) - 1, 0),
        )
        session.add(sheet_record)
        session.flush()
        if not rows:
            continue

        raw_header = rows[0]
        header = [normalize_header(str(value), idx) for idx, value in enumerate(raw_header)]
        table_record = WorkbookTableRecord(
            workbook_sheet_id=sheet_record.id,
            name=f"{sheet_record.name} table 1",
            ordinal=1,
            header_json=header,
            row_count=max(len(rows) - 1, 0),
        )
        session.add(table_record)
        session.flush()
        table_count += 1

        retrieval_artifacts.append(
            RetrievalArtifactRecord(
                document_id=document.id,
                corpus=document.corpus,
                artifact_type="sheet_summary",
                text=bounded_window_text(
                    (
                        f"Workbook {document.filename} sheet {sheet_record.name} contains "
                        f"{max(len(rows) - 1, 0)} data rows with columns {', '.join(header)}."
                    ),
                    chunk_size=settings.app_chunk_size,
                    chunk_overlap=settings.app_chunk_overlap,
                ),
                metadata_json=build_retrieval_metadata(
                    document=document,
                    version=version,
                    artifact_type="sheet_summary",
                    parse_lane=parse_lane,
                    extra_metadata={
                        "entity_type": "workbook_sheet",
                        "sheet_name": sheet_record.name,
                        "table_name": table_record.name,
                        "row_index": None,
                    },
                ),
            )
        )

        for row_idx, raw_row in enumerate(rows[1:], start=2):
            row_json = {
                header[col_idx]: str(raw_row[col_idx]) if col_idx < len(raw_row) and raw_row[col_idx] is not None else ""
                for col_idx in range(len(header))
            }
            row_record = WorkbookRowRecord(
                document_id=document.id,
                workbook_table_id=table_record.id,
                row_index=row_idx,
                row_json=row_json,
                search_text=row_search_text(row_json),
            )
            session.add(row_record)
            session.flush()
            row_count += 1
            row_text = bounded_window_text(
                build_row_artifact_text(
                    filename=document.filename,
                    sheet_name=sheet_record.name,
                    table_name=table_record.name,
                    row_index=row_idx,
                    row_json=row_json,
                ),
                chunk_size=settings.app_chunk_size,
                chunk_overlap=settings.app_chunk_overlap,
            )
            retrieval_artifacts.append(
                RetrievalArtifactRecord(
                    document_id=document.id,
                    corpus=document.corpus,
                    artifact_type="row_summary",
                    text=row_text,
                    metadata_json=build_retrieval_metadata(
                        document=document,
                        version=version,
                        artifact_type="row_summary",
                        parse_lane=parse_lane,
                        extra_metadata={
                            "entity_type": "workbook_row",
                            "sheet_name": sheet_record.name,
                            "table_name": table_record.name,
                            "row_index": row_idx,
                        },
                    ),
                )
            )

    return table_count, row_count, retrieval_artifacts


def persist_text_retrieval_artifacts(
    session,
    *,
    document: DocumentRecord,
    version: DocumentVersionRecord,
    text: str,
    parse_lane: str,
    artifact_type: str = "chunk",
    chunk_size: int,
    chunk_overlap: int,
    heading_aware: bool,
    extra_metadata: dict[str, Any] | None = None,
) -> list[RetrievalArtifactRecord]:
    artifacts: list[RetrievalArtifactRecord] = []
    for idx, chunk in enumerate(
        build_text_retrieval_chunks(
            text,
            chunk_size=chunk_size,
            overlap=chunk_overlap,
            preserve_headings=heading_aware,
        )
    ):
        artifacts.append(
            RetrievalArtifactRecord(
                document_id=document.id,
                corpus=document.corpus,
                artifact_type=artifact_type,
                text=chunk["text"],
                metadata_json=build_retrieval_metadata(
                    document=document,
                    version=version,
                    artifact_type=artifact_type,
                    parse_lane=parse_lane,
                    extra_metadata={
                        **(extra_metadata or {}),
                        "chunk_index": idx,
                        "section_title": chunk.get("section_title"),
                        "section_path": chunk.get("section_path"),
                        "heading_level": chunk.get("heading_level"),
                        "section_index": chunk.get("section_index"),
                        "section_chunk_index": chunk.get("section_chunk_index"),
                        "token_count": estimate_token_count(chunk["text"]),
                    },
                ),
            )
        )
    return artifacts


def build_pdf_retrieval_artifacts(
    *,
    document: DocumentRecord,
    version: DocumentVersionRecord,
    parse_lane: str,
    documents: list[Any],
    chunk_size: int,
    chunk_overlap: int,
    sentence_window: int,
) -> list[RetrievalArtifactRecord]:
    artifacts: list[RetrievalArtifactRecord] = []
    nodes = build_pdf_nodes(documents=documents, window_size=sentence_window)
    for idx, node in enumerate(nodes):
        node_metadata = dict(getattr(node, "metadata", {}) or {})
        original_text = str(node_metadata.get(PDF_ORIGINAL_TEXT_METADATA_KEY) or getattr(node, "text", "")).strip()
        if not original_text:
            continue
        window_text = bounded_window_text(
            str(node_metadata.get(PDF_WINDOW_METADATA_KEY) or original_text).strip(),
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )
        artifacts.append(
            RetrievalArtifactRecord(
                document_id=document.id,
                corpus=document.corpus,
                artifact_type=PDF_ARTIFACT_TYPE,
                text=original_text,
                metadata_json=build_retrieval_metadata(
                    document=document,
                    version=version,
                    artifact_type=PDF_ARTIFACT_TYPE,
                    parse_lane=parse_lane,
                    extra_metadata={
                        "chunk_index": idx,
                        "page_start": node_metadata.get("page_start"),
                        "page_end": node_metadata.get("page_end") or node_metadata.get("page_start"),
                        "section_title": node_metadata.get("section_title"),
                        "token_count": estimate_token_count(original_text),
                        PDF_WINDOW_METADATA_KEY: window_text,
                        PDF_ORIGINAL_TEXT_METADATA_KEY: original_text,
                        "node_id": getattr(node, "node_id", None),
                        "configured_chunk_size": chunk_size,
                        "configured_chunk_overlap": chunk_overlap,
                        "configured_sentence_window": sentence_window,
                    },
                ),
            )
        )
    return artifacts


def build_pdf_document_metadata(*, artifact_count: int, pdf_extraction, pdf_config) -> dict[str, Any]:
    return {
        "artifact_count": artifact_count,
        "page_count": pdf_extraction.page_count,
        "total_text_chars": pdf_extraction.total_text_chars,
        "pdf_chunk_size": pdf_config.chunk_size,
        "pdf_chunk_overlap": pdf_config.chunk_overlap,
        "pdf_sentence_window": pdf_config.sentence_window,
        "pdf_parse_lane_policy": pdf_config.parse_lane_policy,
        "pdf_parse_diagnostics": pdf_extraction.parse_diagnostics,
    }


def select_documents_for_corpus(session, corpus: str) -> list[DocumentRecord]:
    return list(
        session.scalars(
            select(DocumentRecord)
            .where(DocumentRecord.corpus == corpus)
            .order_by(DocumentRecord.updated_at.desc())
        )
    )


def select_documents_for_corpora(session, corpora: list[str]) -> list[DocumentRecord]:
    target_corpora = list(corpora or [settings.app_default_corpus])
    if len(target_corpora) == 1:
        return select_documents_for_corpus(session, target_corpora[0])
    return list(
        session.scalars(
            select(DocumentRecord)
            .where(DocumentRecord.corpus.in_(target_corpora))
            .order_by(DocumentRecord.updated_at.desc())
        )
    )


def build_document_inventory_citations(documents: list[DocumentRecord], *, limit: int = 25) -> list[dict[str, Any]]:
    citations: list[dict[str, Any]] = []
    for document in documents[:limit]:
        citations.append(
            {
                "document_id": document.id,
                "filename": document.filename,
                "corpus": document.corpus,
                "artifact_type": "document_manifest",
                "source_path": document.source_path,
                "parse_lane": document.actual_parse_lane,
            }
        )
    return citations


def build_document_inventory_context(documents: list[DocumentRecord], *, limit: int = 25) -> str:
    if not documents:
        return "Document inventory candidates:\n- No indexed documents were found in the active corpora."

    lines = []
    for document in documents[:limit]:
        metadata = dict(document.metadata_json or {})
        parts = [
            f"filename={document.filename}",
            f"corpus={document.corpus}",
            f"parse_status={document.parse_status}",
            f"index_status={document.index_status}",
        ]
        if document.actual_parse_lane:
            parts.append(f"parse_lane={document.actual_parse_lane}")
        if metadata.get("title"):
            parts.append(f"title={metadata['title']}")
        lines.append("- " + " | ".join(parts))

    remaining = len(documents) - min(len(documents), limit)
    if remaining > 0:
        lines.append(f"- ... {remaining} more document(s) not shown")
    return "Document inventory candidates:\n" + "\n".join(lines)


def build_document_inventory_answer(documents: list[DocumentRecord], corpora: list[str], *, limit: int = 25) -> str:
    corpus_label = ", ".join(corpora or [settings.app_default_corpus])
    if not documents:
        return f"No indexed documents were found in the active corpora: {corpus_label}."

    lines = [f"Indexed files in active corpora {corpus_label} ({len(documents)} total):", ""]
    for document in documents[:limit]:
        parts = [document.filename]
        if document.actual_parse_lane:
            parts.append(f"parse lane: {document.actual_parse_lane}")
        parts.append(f"parse: {document.parse_status}")
        parts.append(f"index: {document.index_status}")
        lines.append("- " + " | ".join(parts))
    if len(documents) > limit:
        lines.append(f"- ... {len(documents) - limit} more file(s) not shown")
    return "\n".join(lines).strip()


def _set_run_document_inventory(run: IngestionRunRecord, documents: list[DocumentRecord]) -> None:
    run.payload_json = {
        **(run.payload_json or {}),
        "document_ids": [document.id for document in documents],
    }
    run.result_json = {
        **(run.result_json or {}),
        "documents_total": len(documents),
        "documents_processed": 0,
        "documents_failed": 0,
        "documents_parse_failed": 0,
        "documents_index_failed": 0,
        "documents_indexed": 0,
        "current_document_id": None,
        "current_filename": None,
    }


def _set_active_document(run: IngestionRunRecord, document: DocumentRecord | None) -> None:
    result = dict(run.result_json or {})
    result["current_document_id"] = document.id if document is not None else None
    result["current_filename"] = document.filename if document is not None else None
    run.result_json = result


class IngestionWorkflow(Workflow):
    @step
    async def prepare(self, ev: StartEvent) -> DocumentsPreparedEvent:
        run_id = str(start_event_value(ev, "ingestion_run_id"))
        trace_id = str(start_event_value(ev, "trace_id"))
        with SessionLocal() as session:
            run = session.get(IngestionRunRecord, run_id)
            if run is None:
                raise ValueError(f"ingestion run {run_id} not found")
            run.status = "running"
            run.current_step = "parse_structure"
            run.progress = 0.05
            documents = select_documents_for_corpus(session, run.corpus)
            _set_run_document_inventory(run, documents)
            session.commit()
            log_instant_event(
                trace_id=trace_id,
                service="workflow-runtime",
                route="ingestion.prepare",
                status="ok",
                details={"run_id": run_id, "corpus": run.corpus, "document_count": len(documents)},
            )
            return DocumentsPreparedEvent(
                run_id=run_id,
                trace_id=trace_id,
                document_ids=[document.id for document in documents],
            )

    @step
    async def parse_and_structure(self, ev: DocumentsPreparedEvent) -> RetrievalPreparedEvent:
        with SessionLocal() as session:
            run = session.get(IngestionRunRecord, ev.run_id)
            if run is None:
                raise ValueError(f"ingestion run {ev.run_id} not found")
            pdf_config = get_pdf_ingestion_config(session)
            text_config = get_text_ingestion_config(session)
            total = max(len(ev.document_ids), 1)
            processed = 0
            failed = 0

            for idx, document_id in enumerate(ev.document_ids, start=1):
                document = session.get(DocumentRecord, document_id)
                if document is None:
                    continue
                _set_active_document(run, document)
                session.commit()
                path = Path(document.source_path)
                if not path.is_file():
                    document.status = "error"
                    document.parse_status = "failed"
                    document.index_status = "failed"
                    document.error_message = "missing file on disk"
                    failed += 1
                    run.result_json = {
                        **(run.result_json or {}),
                        "documents_processed": processed,
                        "documents_failed": failed,
                        "documents_parse_failed": failed,
                    }
                    session.commit()
                    continue

                document.mime_type = mimetypes.guess_type(document.filename)[0]
                document.source_kind = "spreadsheet" if path.suffix.lower() in {".xlsx", ".xlsm"} else "document"
                document.requested_lane = document.requested_lane or "default"
                document.error_message = None
                version = persist_document_version(session, document)
                clear_document_state(session, document.id)

                try:
                    retrieval_artifacts: list[RetrievalArtifactRecord] = []
                    if document.source_kind == "spreadsheet":
                        structure = extract_spreadsheet_structure(path)
                        if structure is None:
                            raise ValueError("failed to parse workbook structure")
                        document.actual_parse_lane = "local_xlsx"
                        sheet_count = int(structure.get("sheet_count", 0))
                        table_count, row_count, retrieval_artifacts = persist_workbook_structure(
                            session,
                            document=document,
                            version=version,
                            parse_lane=document.actual_parse_lane,
                            structure=structure,
                        )
                        if document.requested_lane == "cloud":
                            cloud_text, cloud_lane = extract_text_cloud(path, settings.app_llamaparse_tier, ev.trace_id)
                            document.actual_parse_lane = cloud_lane
                            retrieval_artifacts.extend(
                                persist_text_retrieval_artifacts(
                                    session,
                                    document=document,
                                    version=version,
                                    text=cloud_text,
                                    parse_lane=cloud_lane,
                                    artifact_type="llamaparse_markdown",
                                    chunk_size=text_config.chunk_size,
                                    chunk_overlap=text_config.chunk_overlap,
                                    heading_aware=text_config.heading_aware,
                                    extra_metadata={
                                        "sheet_count": sheet_count,
                                        "table_count": table_count,
                                        "row_count": row_count,
                                        "entity_type": "workbook_markdown",
                                    },
                                )
                            )
                        document.metadata_json = {
                            "sheet_count": sheet_count,
                            "table_count": table_count,
                            "row_count": row_count,
                        }
                    else:
                        if path.suffix.lower() == ".pdf":
                            pdf_extraction = extract_pdf_documents(
                                path=path,
                                requested_lane=document.requested_lane,
                                tier=settings.app_llamaparse_tier,
                                trace_id=ev.trace_id,
                                base_metadata=build_document_base_metadata(document, version),
                                parse_lane_policy=pdf_config.parse_lane_policy,
                            )
                            if not pdf_extraction.documents or pdf_extraction.total_text_chars == 0:
                                raise ValueError("no extractable text found in pdf")
                            document.actual_parse_lane = pdf_extraction.parse_lane
                            retrieval_artifacts = build_pdf_retrieval_artifacts(
                                document=document,
                                version=version,
                                parse_lane=pdf_extraction.parse_lane,
                                documents=pdf_extraction.documents,
                                chunk_size=pdf_config.chunk_size,
                                chunk_overlap=pdf_config.chunk_overlap,
                                sentence_window=pdf_config.sentence_window,
                            )
                            if not retrieval_artifacts:
                                joined_text = "\n\n".join(pdf_document.text for pdf_document in pdf_extraction.documents)
                                retrieval_artifacts = persist_text_retrieval_artifacts(
                                    session,
                                    document=document,
                                    version=version,
                                    text=joined_text,
                                    parse_lane=pdf_extraction.parse_lane,
                                    chunk_size=text_config.chunk_size,
                                    chunk_overlap=text_config.chunk_overlap,
                                    heading_aware=text_config.heading_aware,
                                )
                            document.metadata_json = build_pdf_document_metadata(
                                artifact_count=len(retrieval_artifacts),
                                pdf_extraction=pdf_extraction,
                                pdf_config=pdf_config,
                            )
                        elif document.requested_lane == "cloud":
                            text, parse_lane = extract_text_cloud(path, settings.app_llamaparse_tier, ev.trace_id)
                            document.actual_parse_lane = parse_lane
                            retrieval_artifacts = persist_text_retrieval_artifacts(
                                session,
                                document=document,
                                version=version,
                                text=text,
                                parse_lane=parse_lane,
                                chunk_size=text_config.chunk_size,
                                chunk_overlap=text_config.chunk_overlap,
                                heading_aware=text_config.heading_aware,
                            )
                        else:
                            text, parse_lane = extract_text_local(path)
                            document.actual_parse_lane = parse_lane
                            retrieval_artifacts = persist_text_retrieval_artifacts(
                                session,
                                document=document,
                                version=version,
                                text=text,
                                parse_lane=parse_lane,
                                chunk_size=text_config.chunk_size,
                                chunk_overlap=text_config.chunk_overlap,
                                heading_aware=text_config.heading_aware,
                            )
                        if path.suffix.lower() != ".pdf":
                            document.metadata_json = {
                                "artifact_count": len(retrieval_artifacts),
                                "text_chunk_size": text_config.chunk_size,
                                "text_chunk_overlap": text_config.chunk_overlap,
                                "text_heading_aware": text_config.heading_aware,
                            }

                    for artifact in retrieval_artifacts:
                        session.add(artifact)
                    document.parse_status = "completed"
                    document.index_status = "pending"
                    document.status = "parsed"
                    processed += 1
                    run.result_json = {
                        **(run.result_json or {}),
                        "documents_processed": processed,
                        "documents_failed": failed,
                        "documents_parse_failed": failed,
                    }
                    log_instant_event(
                        trace_id=ev.trace_id,
                        service="workflow-runtime",
                        route="ingestion.parse.completed",
                        status="ok",
                        details={"run_id": ev.run_id, "document_id": document.id, "filename": document.filename},
                    )
                except Exception as exc:
                    document.status = "error"
                    document.parse_status = "failed"
                    document.index_status = "failed"
                    document.error_message = str(exc)[:2000]
                    failed += 1
                    run.result_json = {
                        **(run.result_json or {}),
                        "documents_processed": processed,
                        "documents_failed": failed,
                        "documents_parse_failed": failed,
                    }
                    log_instant_event(
                        trace_id=ev.trace_id,
                        service="workflow-runtime",
                        route="ingestion.parse.failed",
                        status="error",
                        error=repr(exc),
                        details={"run_id": ev.run_id, "document_id": document.id, "filename": document.filename},
                    )
                run.progress = min(0.55, 0.05 + (0.5 * idx / total))
                session.commit()

            run.current_step = "index_retrieval"
            run.progress = max(run.progress, 0.6)
            run.result_json = {
                **(run.result_json or {}),
                "documents_processed": processed,
                "documents_failed": failed,
                "documents_parse_failed": failed,
                "current_document_id": None,
                "current_filename": None,
            }
            session.commit()
        return RetrievalPreparedEvent(run_id=ev.run_id, trace_id=ev.trace_id, document_ids=ev.document_ids)

    @step
    async def index_retrieval(self, ev: RetrievalPreparedEvent) -> StopEvent:
        with SessionLocal() as session:
            run = session.get(IngestionRunRecord, ev.run_id)
            if run is None:
                raise ValueError(f"ingestion run {ev.run_id} not found")
            connection = get_active_connection(session, "openai")
            kb_config = dict(get_default_runtime_profile(session).kb_config_json or {})
            embedding_model_id = kb_config.get("embedding_model_id")
            total = max(len(ev.document_ids), 1)
            parse_failed = int((run.result_json or {}).get("documents_parse_failed", 0))
            failed = int((run.result_json or {}).get("documents_failed", 0))
            indexed = int((run.result_json or {}).get("documents_indexed", 0))

            for idx, document_id in enumerate(ev.document_ids, start=1):
                document = session.get(DocumentRecord, document_id)
                if document is None or document.parse_status != "completed":
                    continue
                _set_active_document(run, document)
                session.commit()
                artifacts = list(
                    session.scalars(
                        select(RetrievalArtifactRecord)
                        .where(RetrievalArtifactRecord.document_id == document.id)
                        .order_by(RetrievalArtifactRecord.created_at.asc())
                    )
                )
                current_batch_index: int | None = None
                current_batch_points = 0
                current_batch_bytes = 0
                try:
                    delete_document_vectors(document.id, trace_id=ev.trace_id, service="workflow-runtime")
                    valid_artifacts = [artifact for artifact in artifacts if artifact.text.strip()]
                    texts = [
                        str(artifact.metadata_json.get(PDF_ORIGINAL_TEXT_METADATA_KEY) or artifact.text)
                        for artifact in valid_artifacts
                    ]
                    vectors = embed_texts(
                        texts,
                        connection,
                        embedding_model=embedding_model_id,
                        trace_id=ev.trace_id,
                        service="workflow-runtime",
                    )
                    payloads = [build_qdrant_payload(document, artifact) for artifact in valid_artifacts if artifact.text.strip()]
                    point_ids: list[str] = []
                    upsert_batches = build_qdrant_upsert_batches(payloads, vectors)
                    estimated_upsert_bytes = 0
                    for current_batch_index, (batch_payloads, batch_vectors, batch_bytes) in enumerate(upsert_batches, start=1):
                        current_batch_points = len(batch_payloads)
                        current_batch_bytes = batch_bytes
                        estimated_upsert_bytes += batch_bytes
                        point_ids.extend(
                            upsert_retrieval_artifacts(
                                artifacts=batch_payloads,
                                vectors=batch_vectors,
                                trace_id=ev.trace_id,
                                service="workflow-runtime",
                            )
                        )
                        log_instant_event(
                            trace_id=ev.trace_id,
                            service="workflow-runtime",
                            route="ingestion.index.upsert.batch",
                            status="ok",
                            details={
                                "run_id": ev.run_id,
                                "document_id": document.id,
                                "filename": document.filename,
                                "batch_index": current_batch_index,
                                "batch_count": len(upsert_batches),
                                "batch_points": current_batch_points,
                                "estimated_request_bytes": current_batch_bytes,
                            },
                        )
                    for artifact, point_id in zip(valid_artifacts, point_ids, strict=True):
                        artifact.qdrant_point_id = point_id
                    document.index_status = "completed"
                    document.status = "indexed"
                    document.error_message = None
                    indexed += 1
                    run.result_json = {
                        **(run.result_json or {}),
                        "documents_failed": failed,
                        "documents_parse_failed": parse_failed,
                        "documents_index_failed": failed - parse_failed,
                        "documents_indexed": indexed,
                    }
                    log_instant_event(
                        trace_id=ev.trace_id,
                        service="workflow-runtime",
                        route="ingestion.index.completed",
                        status="ok",
                        details={
                            "run_id": ev.run_id,
                            "document_id": document.id,
                            "filename": document.filename,
                            "upsert_batches": len(upsert_batches),
                            "estimated_upsert_bytes": estimated_upsert_bytes,
                        },
                    )
                except Exception as exc:
                    document.index_status = "failed"
                    document.status = "error"
                    document.error_message = str(exc)[:2000]
                    failed += 1
                    run.result_json = {
                        **(run.result_json or {}),
                        "documents_failed": failed,
                        "documents_parse_failed": parse_failed,
                        "documents_index_failed": failed - parse_failed,
                        "documents_indexed": indexed,
                    }
                    log_instant_event(
                        trace_id=ev.trace_id,
                        service="workflow-runtime",
                        route="ingestion.index.failed",
                        status="error",
                        error=repr(exc),
                        details={
                            "run_id": ev.run_id,
                            "document_id": document.id,
                            "filename": document.filename,
                            "batch_index": current_batch_index,
                            "batch_points": current_batch_points,
                            "estimated_request_bytes": current_batch_bytes,
                        },
                    )
                run.progress = min(0.95, 0.6 + (0.35 * idx / total))
                session.commit()

            run.current_step = "finalize"
            run.progress = 1.0
            run.status = "completed" if failed == 0 else "failed"
            _set_active_document(run, None)
            index_failed = max(0, failed - parse_failed)
            run.result_json = {
                **(run.result_json or {}),
                "documents_failed": failed,
                "documents_parse_failed": parse_failed,
                "documents_index_failed": index_failed,
                "documents_indexed": indexed,
            }
            run.error_message = build_run_failure_message(parse_failed=parse_failed, index_failed=index_failed)
            session.commit()
            log_instant_event(
                trace_id=ev.trace_id,
                service="workflow-runtime",
                route="ingestion.run.completed",
                status=run.status,
                details={"run_id": run.id, "documents_failed": failed, "documents_total": len(ev.document_ids)},
                error=run.error_message,
            )
            return StopEvent(result={"run_id": run.id, "status": run.status, "error_message": run.error_message})


def classify_query_mode(message: str) -> str:
    lowered = message.lower()
    structured_tokens = ["sku", "price", "amount", "total", "status", "customer", "invoice", "row", "sheet", "id"]
    has_structured_signal = any(
        re.search(rf"\b{re.escape(token)}\b", lowered)
        for token in structured_tokens
    )
    has_identifier = bool(re.search(r"\b[A-Z]{2,}\d+\b|\b\d{2,}\b", message))
    asks_for_overview = any(token in lowered for token in ["summary", "summarize", "overview", "explain"])
    asks_for_strategy = any(
        phrase in lowered
        for phrase in [
            "strategy",
            "strategic",
            "business plan",
            "position paper",
            "direction",
            "forecast",
            "turnover",
            "financial",
            "position",
            "detailed",
        ]
    )
    if asks_for_strategy:
        return "semantic"
    if has_structured_signal and has_identifier:
        return "structured"
    if has_structured_signal and not asks_for_overview:
        return "structured"
    if has_structured_signal:
        return "blended"
    return "semantic"


def needs_document_inventory_context(message: str) -> bool:
    lowered = message.lower()
    inventory_phrases = (
        "file inventory",
        "document inventory",
        "file list",
        "document list",
        "loaded files",
        "loaded documents",
        "filename",
        "filenames",
        "file names",
        "metadata",
        "what files",
        "which files",
        "what documents",
        "which documents",
        "exact file name",
        "title",
        "titles",
        "identifiable by name",
    )
    if any(phrase in lowered for phrase in inventory_phrases):
        return True
    return "do you have any" in lowered and "document" in lowered


def message_explicitly_requests_knowledge(message: str) -> bool:
    lowered = str(message or "").strip().casefold()
    if not lowered:
        return False
    explicit_phrases = (
        "search the knowledge",
        "search knowledge",
        "search the documents",
        "search documents",
        "look in the document",
        "look in the file",
        "look in the knowledge",
        "from the document",
        "from the file",
        "in the knowledge base",
        "knowledge base",
        "indexed document",
        "retrieved document",
        "what does the file",
        "what do the files",
        "according to the document",
        "according to the file",
        "cite the document",
        "use the document",
        "use the knowledge",
        "check the spreadsheet",
        "check the workbook",
        "in jobs booked",
    )
    if any(phrase in lowered for phrase in explicit_phrases):
        return True
    return bool(re.search(r"\b[\w\- ]+\.(xlsx|xls|csv|pdf|docx?|pptx?|txt)\b", lowered))


def message_has_structured_retrieval_signals(message: str) -> bool:
    mode = classify_query_mode(message)
    if mode not in {"structured", "blended"}:
        return False
    lowered = message.lower()
    structured_tokens = ["sku", "price", "amount", "total", "status", "customer", "invoice", "row", "sheet"]
    return any(re.search(rf"\b{re.escape(token)}\b", lowered) for token in structured_tokens)


def should_run_knowledge_retrieval(
    *,
    message: str,
    kb_session_enabled: bool,
    corpora: list[str],
) -> bool:
    if not kb_session_enabled or not corpora:
        return False
    if needs_document_inventory_context(message):
        return True
    if message_explicitly_requests_knowledge(message):
        return True
    if message_has_structured_retrieval_signals(message):
        return True
    return False


def is_document_inventory_listing_question(message: str) -> bool:
    lowered = message.lower()
    listing_phrases = (
        "what files",
        "which files",
        "list files",
        "show files",
        "file inventory",
        "file list",
        "what documents",
        "which documents",
        "list documents",
        "show documents",
        "document inventory",
        "document list",
        "what metadata",
        "show metadata",
        "can you see any metadata",
        "identifiable by name",
        "full file list",
        "file inventory",
    )
    return any(phrase in lowered for phrase in listing_phrases)


def find_structured_candidates(message: str, corpora: list[str]) -> list[dict[str, Any]]:
    lowered = message.lower()
    search_terms = [term for term in re.findall(r"[A-Za-z0-9_.-]+", lowered) if len(term) > 1]
    if not search_terms:
        return []
    with SessionLocal() as session:
        documents = select_documents_for_corpora(session, corpora)
        document_ids = [document.id for document in documents]
        if not document_ids:
            return []
        rows = list(
            session.scalars(
                select(WorkbookRowRecord)
                .where(WorkbookRowRecord.document_id.in_(document_ids))
                .order_by(WorkbookRowRecord.created_at.desc())
            )
        )
        table_ids = {row.workbook_table_id for row in rows}
        tables = _fetch_workbook_tables_by_ids(session, table_ids)
        sheet_ids = {table.workbook_sheet_id for table in tables.values()}
        sheets = _fetch_workbook_sheets_by_ids(session, sheet_ids)
        docs = {document.id: document for document in documents}
        scored: list[dict[str, Any]] = []
        for row in rows:
            haystack = row.search_text.lower()
            score = sum(1 for term in search_terms if term in haystack)
            if score == 0:
                continue
            table = tables.get(row.workbook_table_id)
            sheet = sheets.get(table.workbook_sheet_id) if table else None
            document = docs.get(row.document_id)
            if table is None or sheet is None or document is None:
                continue
            scored.append(
                {
                    "score": score,
                    "document": document,
                    "table": table,
                    "sheet": sheet,
                    "row": row,
                }
            )
        scored.sort(key=lambda item: item["score"], reverse=True)
        return scored[:5]


def _semantic_hit_key(hit: dict[str, Any]) -> tuple[Any, ...]:
    metadata = hit.get("metadata", {}) or {}
    return (
        hit.get("document_id"),
        hit.get("artifact_type", "chunk"),
        hit.get("source_path"),
        hit.get("chunk_index", metadata.get("chunk_index")),
        hit.get("page_start", metadata.get("page_start")),
        hit.get("page_end", metadata.get("page_end")),
        hit.get("section_path", metadata.get("section_path")),
        hit.get("section_title", metadata.get("section_title")),
        metadata.get("sheet_name"),
        metadata.get("table_name"),
        metadata.get("row_index"),
        hit.get("text", ""),
    )


def _citation_key(citation: dict[str, Any]) -> tuple[Any, ...]:
    return (
        citation.get("document_id"),
        citation.get("artifact_type"),
        citation.get("source_path"),
        citation.get("chunk_index"),
        citation.get("page_start"),
        citation.get("page_end"),
        citation.get("section_path"),
        citation.get("sheet_name"),
        citation.get("table_name"),
        citation.get("row_index"),
    )


def build_semantic_hit_context(hit: dict[str, Any]) -> str:
    metadata = hit.get("metadata", {}) or {}
    location_parts: list[str] = []
    page_start = hit.get("page_start", metadata.get("page_start"))
    page_end = hit.get("page_end", metadata.get("page_end"))
    if page_start is not None:
        if page_end is not None and page_end != page_start:
            location_parts.append(f"pages={page_start}-{page_end}")
        else:
            location_parts.append(f"page={page_start}")
    if metadata.get("sheet_name"):
        location_parts.append(f"sheet={metadata['sheet_name']}")
    if metadata.get("table_name"):
        location_parts.append(f"table={metadata['table_name']}")
    if metadata.get("row_index") is not None:
        location_parts.append(f"row={metadata['row_index']}")
    section_path = hit.get("section_path", metadata.get("section_path"))
    semantic_parts = [
        f"filename={hit['filename']}",
        f"corpus={hit['corpus']}",
        f"artifact_type={hit.get('artifact_type', 'chunk')}",
    ]
    if hit.get("source_path"):
        semantic_parts.append(f"source_path={hit['source_path']}")
    parse_lane = hit.get("parse_lane", metadata.get("parse_lane"))
    if parse_lane:
        semantic_parts.append(f"parse_lane={parse_lane}")
    if section_path:
        semantic_parts.append(f"section_path={section_path}")
    semantic_parts.extend(location_parts)
    return "Metadata: " + " | ".join(semantic_parts) + "\nRetrieved text:\n" + hit["text"]


def build_semantic_hit_citation(hit: dict[str, Any]) -> dict[str, Any]:
    metadata = hit.get("metadata", {}) or {}
    return {
        "document_id": hit["document_id"],
        "filename": hit["filename"],
        "corpus": hit["corpus"],
        "artifact_type": hit.get("artifact_type", "chunk"),
        "source_path": hit["source_path"],
        "chunk_index": hit.get("chunk_index"),
        "page_start": hit.get("page_start", metadata.get("page_start")),
        "page_end": hit.get("page_end", metadata.get("page_end")),
        "section_title": hit.get("section_title", metadata.get("section_title")),
        "section_path": hit.get("section_path", metadata.get("section_path")),
        "heading_level": hit.get("heading_level", metadata.get("heading_level")),
        "parse_lane": hit.get("parse_lane", metadata.get("parse_lane")),
        "sheet_name": metadata.get("sheet_name"),
        "table_name": metadata.get("table_name"),
        "row_index": metadata.get("row_index"),
    }


def collect_semantic_context_and_citations(
    hits: list[dict[str, Any]],
    *,
    seen_hit_keys: set[tuple[Any, ...]] | None = None,
    seen_citation_keys: set[tuple[Any, ...]] | None = None,
) -> tuple[list[str], list[dict[str, Any]]]:
    hit_keys = seen_hit_keys if seen_hit_keys is not None else set()
    citation_keys = seen_citation_keys if seen_citation_keys is not None else set()
    context: list[str] = []
    citations: list[dict[str, Any]] = []
    for hit in hits:
        hit_key = _semantic_hit_key(hit)
        if hit_key in hit_keys:
            continue
        hit_keys.add(hit_key)
        context.append(build_semantic_hit_context(hit))
        citation = build_semantic_hit_citation(hit)
        citation_key = _citation_key(citation)
        if citation_key in citation_keys:
            continue
        citation_keys.add(citation_key)
        citations.append(citation)
    return context, citations


def _normalize_filename_lookup(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def _message_mentions_filename(message: str, filename: str) -> bool:
    lowered = message.casefold()
    if filename.casefold() in lowered:
        return True
    normalized_message = _normalize_filename_lookup(message)
    normalized_filename = _normalize_filename_lookup(filename)
    if normalized_filename and normalized_filename in normalized_message:
        return True
    normalized_stem = _normalize_filename_lookup(Path(filename).stem)
    return len(normalized_stem) >= 12 and normalized_stem in normalized_message


def _summarize_semantic_documents(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summaries: dict[str, dict[str, Any]] = {}
    for rank, hit in enumerate(hits):
        document_id = str(hit.get("document_id") or "").strip()
        if not document_id:
            continue
        summary = summaries.setdefault(
            document_id,
            {
                "document_id": document_id,
                "filename": hit.get("filename", ""),
                "corpus": hit.get("corpus", ""),
                "hit_count": 0,
                "score_sum": 0.0,
                "first_rank": rank,
            },
        )
        summary["hit_count"] += 1
        summary["score_sum"] += max(float(hit.get("score") or 0.0), 0.0)
    return sorted(
        summaries.values(),
        key=lambda item: (-int(item["hit_count"]), -float(item["score_sum"]), int(item["first_rank"])),
    )


def _document_expansion_limit(top_k: int) -> int:
    normalized_top_k = max(1, int(top_k))
    return min(
        max(normalized_top_k * DOCUMENT_EXPANSION_LIMIT_MULTIPLIER, DOCUMENT_EXPANSION_LIMIT_FLOOR),
        DOCUMENT_EXPANSION_LIMIT_CAP,
    )


def _document_selection_reason_label(reason: str) -> str:
    if reason == "filename_mention":
        return "filename mention"
    return "document dominance"


def _extract_company_scope(message: str, *, fallback_message: str | None = None) -> dict[str, Any]:
    match = ODOO_COMPANY_ID_PATTERN.search(message)
    if match:
        company_id = int(match.group(1))
        return {
            "company_id": company_id,
            "scope_label": f"company_id={company_id}",
            "ambiguous": False,
        }
    if fallback_message:
        fallback_matches = ODOO_COMPANY_ID_PATTERN.findall(fallback_message)
        if fallback_matches:
            company_id = int(fallback_matches[-1])
            return {
                "company_id": company_id,
                "scope_label": f"company_id={company_id}",
                "ambiguous": False,
            }

    lowered = message.casefold()
    scope_hint = any(
        token in lowered
        for token in (
            "one company only",
            "single company",
            "specific company",
            "this company only",
            "company only",
        )
    )
    return {
        "company_id": None,
        "company_ids": [],
        "scope_label": None,
        "ambiguous": scope_hint,
    }


def _extract_company_ids(message: str, *, fallback_message: str | None = None) -> list[int]:
    def _parse(value: str) -> list[int]:
        value = _strip_non_user_scope_history(value)
        output: list[int] = []
        explicit_matches = [int(match) for match in ODOO_COMPANY_ID_PATTERN.findall(value)]
        for parsed in explicit_matches:
            if parsed not in output:
                output.append(parsed)
        list_match = ODOO_COMPANY_LIST_PATTERN.search(value)
        if list_match:
            for raw in re.findall(r"\b\d+\b", list_match.group(1)):
                parsed = int(raw)
                # Ignore year-like values that often appear in finance periods (e.g., FY25/2026)
                # when parsing loose "companies ..." text. Explicit company_id forms still pass above.
                if 1900 <= parsed <= 2100 and parsed not in explicit_matches:
                    continue
                if parsed not in output:
                    output.append(parsed)
        return output

    explicit = _parse(message)
    if explicit:
        return explicit
    if fallback_message:
        return _parse(fallback_message)
    return []


def _is_operation_preview_request(message: str) -> bool:
    lowered = message.casefold()
    return any(term in lowered for term in ODOO_OPERATION_PREVIEW_TERMS)


def _tool_preview_payload(operation: str, payload: dict[str, Any]) -> str:
    return json.dumps({"operation": operation, "payload": payload}, indent=2, sort_keys=True)


def _build_odoo_preview_answer(
    *,
    operation: str,
    payload: dict[str, Any],
    why_correct: str,
    why_meta_current_user_is_insufficient: str | None = None,
) -> str:
    lines = [
        operation,
        "",
        "```json",
        _tool_preview_payload(operation, payload),
        "```",
        "",
        why_correct,
    ]
    if why_meta_current_user_is_insufficient:
        lines.extend(
            [
                "",
                why_meta_current_user_is_insufficient,
            ]
        )
    return "\n".join(lines).strip()


def _build_scope_clarification_answer(scope_hint: dict[str, Any], question: str) -> str:
    scope_label = scope_hint.get("scope_label") or "a specific company_id"
    return (
        "I cannot safely execute Odoo for this question yet because the company scope is ambiguous.\n\n"
        f"Please provide {scope_label} so I can apply explicit company filtering before answering:\n"
        f"- requested question: {question.strip()}"
    )


def _strip_non_user_scope_history(value: str) -> str:
    """Remove assistant/tool evidence lines before extracting company IDs from history."""
    noisy_prefixes = (
        "assistant:",
        "tool:",
        "execution legend",
        "execution_truth",
        "execution truth",
        "source:",
        "window:",
        "primary:",
        "companies:",
    )
    kept_lines: list[str] = []
    for line in str(value or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.casefold().startswith(noisy_prefixes):
            continue
        kept_lines.append(stripped)
    return "\n".join(kept_lines)


def _normalize_fiscal_year(value: str) -> int:
    raw = str(value or "").strip()
    if len(raw) == 4:
        return int(raw)
    if len(raw) == 2:
        candidate = int(raw)
        return 2000 + candidate if candidate < 70 else 1900 + candidate
    raise ValueError(f"Unsupported fiscal year token: {value}")


def _extract_fiscal_year_ranges(message: str) -> list[tuple[date, date, str]]:
    matches = re.finditer(r"\bfy\s*(\d{2,4})(?:\s*/\s*(\d{2,4}))?\b", message.casefold())
    ranges: list[tuple[date, date, str]] = []
    seen_labels: set[str] = set()
    for match in matches:
        first = _normalize_fiscal_year(match.group(1))
        second_raw = match.group(2)
        if second_raw:
            second = _normalize_fiscal_year(second_raw)
            start_year = first
            end_year = second
            label = f"FY{str(first)[-2:]}/{str(second)[-2:]}"
        else:
            end_year = first
            start_year = end_year - 1
            label = f"FY{str(end_year)[-2:]}"
        if end_year <= start_year:
            continue
        if label in seen_labels:
            continue
        seen_labels.add(label)
        ranges.append((date(start_year, 7, 1), date(end_year, 7, 1), label))
    ranges.sort(key=lambda item: item[0])
    return ranges


def _normalize_planning_text(message: str) -> str:
    """Normalize common user typos so Odoo tool planning stays robust."""
    lowered = (message or "").casefold()
    # Collapse repeated letters in words (e.g. "lasst", "monthss", "saless").
    collapsed = re.sub(r"([a-z])\1{1,}", r"\1", lowered)
    replacements = {
        "maraketing": "marketing",
        "marketting": "marketing",
        "shopfy": "shopify",
        "finacial": "financial",
        "finanical": "financial",
        "financials": "financial",
    }
    normalized = collapsed
    for source, target in replacements.items():
        normalized = normalized.replace(source, target)
    # Letter-collapse turns legitimate words like "gross"/"loss" into "gros"/"los"; restore finance tokens.
    normalized = normalized.replace("gros profit", "gross profit")
    normalized = normalized.replace("gros margin", "gross margin")
    return normalized


def _extract_period_scope(message: str) -> dict[str, Any]:
    lowered = _normalize_planning_text(message)
    today = datetime.now(UTC).date()
    current_month_start = today.replace(day=1)
    explicit_from_to_now_match = re.search(
        r"\b(?:from\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+"
        r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|"
        r"sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+"
        r"(20\d{2}|19\d{2})\s+(?:to|til|till|until|through)\s+"
        r"(?:now|today|date|current)\b",
        lowered,
    )
    if explicit_from_to_now_match:
        start_day = int(explicit_from_to_now_match.group(1))
        start_month = ODOO_MONTH_NAME_ALIASES[explicit_from_to_now_match.group(2)]
        start_year = int(explicit_from_to_now_match.group(3))
        try:
            period_start = date(start_year, start_month, start_day)
        except ValueError:
            period_start = None
        if period_start is not None:
            return {
                "relative_period": f"from_{period_start.isoformat()}_to_today",
                "date_from": period_start.isoformat(),
                "date_to": (today + timedelta(days=1)).isoformat(),
                "label": f"{period_start.strftime('%d %b %Y')} to today",
                "month_count": max(1, ((today.year - period_start.year) * 12) + (today.month - period_start.month) + 1),
            }
    fiscal_year_ranges = _extract_fiscal_year_ranges(lowered)
    if fiscal_year_ranges:
        start_date = fiscal_year_ranges[0][0]
        end_date = fiscal_year_ranges[-1][1]
        labels = [label for _start, _end, label in fiscal_year_ranges]
        month_count = max(1, ((end_date.year - start_date.year) * 12) + (end_date.month - start_date.month))
        return {
            "relative_period": "_to_".join(label.lower().replace("/", "_") for label in labels),
            "date_from": start_date.isoformat(),
            "date_to": end_date.isoformat(),
            "label": " to ".join(labels),
            "month_count": month_count,
        }
    day_range_match = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:/|-|and)\s*(\d{1,2})(?:st|nd|rd|th)?\s+"
        r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|"
        r"sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2}|19\d{2})\b",
        lowered,
    )
    if day_range_match:
        start_day = int(day_range_match.group(1))
        end_day = int(day_range_match.group(2))
        month_number = ODOO_MONTH_NAME_ALIASES[day_range_match.group(3)]
        year_number = int(day_range_match.group(4))
        start_day, end_day = sorted((start_day, end_day))
        try:
            period_start = date(year_number, month_number, start_day)
            period_end = date(year_number, month_number, end_day) + timedelta(days=1)
        except ValueError:
            period_start = None
            period_end = None
        if period_start is not None and period_end is not None:
            return {
                "relative_period": f"{year_number}-{month_number:02d}-{start_day:02d}_to_{year_number}-{month_number:02d}-{end_day:02d}",
                "date_from": period_start.isoformat(),
                "date_to": period_end.isoformat(),
                "label": f"{start_day}-{end_day} {date(year_number, month_number, 1).strftime('%b')} {year_number}",
                "month_count": 1,
            }
    if "year so far" in lowered or "ytd" in lowered or "year-to-date" in lowered:
        period_start = date(today.year, 1, 1)
        return {
            "relative_period": f"ytd_{today.year}",
            "date_from": period_start.isoformat(),
            "date_to": (today + timedelta(days=1)).isoformat(),
            "label": f"YTD {today.year}",
            "month_count": today.month,
        }
    if "this year" in lowered and "last year" not in lowered:
        period_start = date(today.year, 1, 1)
        return {
            "relative_period": f"this_year_{today.year}",
            "date_from": period_start.isoformat(),
            "date_to": (today + timedelta(days=1)).isoformat(),
            "label": f"{today.year} year-to-date",
            "month_count": today.month,
        }
    year_matches = [int(value) for value in re.findall(r"\b(20\d{2}|19\d{2})\b", lowered)]
    month_tokens = [ODOO_MONTH_NAME_ALIASES[token.group(1)] for token in ODOO_MONTH_TOKEN_PATTERN.finditer(lowered)]
    if len(month_tokens) >= 2 and year_matches:
        year_number = year_matches[-1]
        start_month = month_tokens[0]
        end_month = month_tokens[-1]
        if start_month <= end_month:
            period_start = date(year_number, start_month, 1)
            period_end = _add_months(date(year_number, end_month, 1), 1)
            label_start = date(year_number, start_month, 1).strftime("%b")
            label_end = date(year_number, end_month, 1).strftime("%b")
            return {
                "relative_period": f"{year_number}-{start_month:02d}_to_{year_number}-{end_month:02d}",
                "date_from": period_start.isoformat(),
                "date_to": period_end.isoformat(),
                "label": f"{label_start}-{label_end} {year_number}",
                "month_count": (end_month - start_month) + 1,
            }
    month_name_match = re.search(
        r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{4})\b",
        lowered,
    )
    if month_name_match:
        month_number = ODOO_MONTH_NAME_ALIASES[month_name_match.group(1)]
        year_number = int(month_name_match.group(2))
        period_start = date(year_number, month_number, 1)
        return {
            "relative_period": f"{month_name_match.group(1)}_{year_number}",
            "date_from": period_start.isoformat(),
            "date_to": _add_months(period_start, 1).isoformat(),
            "label": f"{month_name_match.group(1).title()} {year_number}",
            "month_count": 1,
        }
    month_only_match = re.search(
        r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b",
        lowered,
    )
    if month_only_match:
        month_number = ODOO_MONTH_NAME_ALIASES[month_only_match.group(1)]
        # If the requested month is ahead of the current month, resolve to the most recent closed occurrence.
        year_number = today.year - 1 if month_number > today.month else today.year
        period_start = date(year_number, month_number, 1)
        return {
            "relative_period": f"{month_only_match.group(1)}_{year_number}",
            "date_from": period_start.isoformat(),
            "date_to": _add_months(period_start, 1).isoformat(),
            "label": f"{month_only_match.group(1).title()} {year_number}",
            "month_count": 1,
        }
    if "last month" in lowered:
        period_start = _add_months(current_month_start, -1)
        return {
            "relative_period": "last_month",
            "date_from": period_start.isoformat(),
            "date_to": current_month_start.isoformat(),
            "label": "last month",
            "month_count": 1,
        }
    if "this month" in lowered or "current month" in lowered:
        return {
            "relative_period": "this_month",
            "date_from": current_month_start.isoformat(),
            "date_to": _add_months(current_month_start, 1).isoformat(),
            "label": "this month",
            "month_count": 1,
        }
    if "month-to-date" in lowered or "month to date" in lowered or re.search(r"\bmtd\b", lowered):
        return {
            "relative_period": "month_to_date",
            "date_from": current_month_start.isoformat(),
            "date_to": (today + timedelta(days=1)).isoformat(),
            "label": "month-to-date",
            "month_count": 1,
        }
    # "Previous 5 days from 20/04/2026" — anchored window (N days ending the day *before* anchor date, half-open [from, to)).
    anchor_prev = re.search(
        r"\b(?:previous|prior)\s+(\d+)\s+days?\s+from\s+(?:the\s+)?"
        r"(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b",
        lowered,
    )
    if anchor_prev:
        n_days = max(1, min(120, int(anchor_prev.group(1))))
        day = int(anchor_prev.group(2))
        month = int(anchor_prev.group(3))
        year = int(anchor_prev.group(4))
        try:
            anchor = date(year, month, day)
        except ValueError:
            anchor = None
        if anchor is not None:
            period_start = anchor - timedelta(days=n_days)
            return {
                "relative_period": f"previous_{n_days}_days_before_{anchor.isoformat()}",
                "date_from": period_start.isoformat(),
                "date_to": anchor.isoformat(),
                "label": f"previous {n_days} days before {anchor.strftime('%d %b %Y')}",
                "month_count": 1,
            }
    day_span_match = re.search(r"\b(?:last|past|previous)\s+(\d+)\s+days?\b", lowered)
    if day_span_match:
        day_span = max(1, min(120, int(day_span_match.group(1))))
        period_start = today - timedelta(days=day_span - 1)
        return {
            "relative_period": f"last_{day_span}_days",
            "date_from": period_start.isoformat(),
            "date_to": (today + timedelta(days=1)).isoformat(),
            "label": f"last {day_span} days",
            "month_count": 1,
        }
    if (
        "as of today" in lowered
        or "up to date" in lowered
        or "up-to-date" in lowered
        or "upto date" in lowered
        or "today" in lowered
        or "real-time" in lowered
        or "realtime" in lowered
    ):
        return {
            "relative_period": "month_to_date",
            "date_from": current_month_start.isoformat(),
            "date_to": (today + timedelta(days=1)).isoformat(),
            "label": "month-to-date through today",
            "month_count": 1,
        }
    return {"relative_period": None, "date_from": None, "date_to": None, "label": None, "month_count": None}


def _extract_month_span(message: str) -> int | None:
    lowered = _normalize_planning_text(message)
    match = re.search(r"\b(?:last|past)\s+(\d+)\s+(?:completed\s+)?months?\b", lowered)
    if match:
        return max(1, min(24, int(match.group(1))))
    if "last month" in lowered:
        return 1
    return None


def _infer_company_scope_lock_canonical(message: str, fallback_message: str | None = None) -> str | None:
    """When the user says 'Brisbane only' / 'only Brisbane', force a single named outlet scope."""
    for text in (message, fallback_message or ""):
        if not str(text or "").strip():
            continue
        t = _normalize_planning_text(str(text))
        for pattern in (
            r"\b(brisbane|burleigh|retail)\s+(?:only|alone|exclusively)\b",
            r"\b(?:only|just|strictly)\s+(?:for\s+)?(?:the\s+)?(brisbane|burleigh|retail)\b",
            r"\b(?:only|just)\s+for\s+(?:the\s+)?(brisbane|burleigh|retail)\b",
            r"\bfor\s+(?:the\s+)?(brisbane|burleigh|retail)\s+(?:only|alone|exclusively)\b",
        ):
            match = re.search(pattern, t)
            if match:
                return match.group(1)
    return None


def _extract_company_name_terms(message: str, *, fallback_message: str | None = None) -> list[str]:
    haystacks = [message]
    if fallback_message:
        haystacks.append(fallback_message)
    matches: list[str] = []
    for canonical_name, aliases in ODOO_COMPANY_NAME_HINTS.items():
        found = False
        for haystack in haystacks:
            if not haystack:
                continue
            hay = haystack.casefold()
            for alias in aliases:
                if alias == "retail":
                    ok = re.search(r"\bretail\b", hay) is not None
                else:
                    ok = re.search(rf"\b{re.escape(alias)}\b", hay) is not None
                if ok:
                    found = True
                    break
            if found:
                break
        if found:
            matches.append(canonical_name)
    combined = _normalize_planning_text(f"{message} {fallback_message or ''}")
    if "brisbane" in matches and "retail" in matches:
        if re.search(r"\bbrisbane\b\s+\bretail\b\s+(?:outlet|store|branch|location|shop)\b", combined):
            matches = [term for term in matches if term != "retail"]
    return matches


def _looks_like_finance_performance_question(lowered: str) -> bool:
    return any(
        term in lowered
        for term in (
            "performer",
            "performance",
            "performing",
            "underperform",
            "under performer",
            "underperformer",
            "worst",
            "best",
            "rank",
            "ranking",
            "branch",
            "branches",
            "breakdown",
            "break down",
            "year so far",
            "ytd",
            "year-to-date",
        )
    )


def _looks_like_mixed_finance_period_request(*, lowered: str, asks_for_cogs_scope: bool) -> bool:
    asks_for_revenue = "revenue" in lowered
    asks_for_margin = any(term in lowered for term in ("gross margin", "gross profit", " gp ", " margin "))
    return asks_for_revenue and (asks_for_cogs_scope or asks_for_margin)


def _looks_like_branch_ranking_request(lowered: str) -> bool:
    ranking_terms = ("underperform", "underperformer", "worst", "best", "rank", "ranking", "performer")
    branch_terms = ("branch", "branches", "retail", "burleigh", "brisbane", "entity", "entities", "business", "businesses")
    return any(term in lowered for term in ranking_terms) and any(term in lowered for term in branch_terms)


def _looks_like_product_branch_exploration(lowered: str) -> bool:
    return any(
        term in lowered
        for term in (
            "compare",
            "versus",
            " vs ",
            "contrast",
            "between",
        )
    )


def _looks_like_sales_drilldown_request(lowered: str) -> bool:
    asks_for_drill = any(term in lowered for term in ("drill down", "drilldown", "leading", "top"))
    mentions_sales_agent = any(term in lowered for term in ("sales agent", "salesperson", "sales person"))
    mentions_product = any(term in lowered for term in ("product sold", "top product", "leading product"))
    mentions_payment = any(term in lowered for term in ("payment method", "payment type", "payment breakdown"))
    return asks_for_drill and (mentions_sales_agent or mentions_product or mentions_payment)


def _looks_like_top_products_gp_request(lowered: str) -> bool:
    mentions_top_products = bool(re.search(r"\btop\s*\d+\b", lowered)) or "top products" in lowered
    mentions_products = "product" in lowered
    mentions_gp = any(term in lowered for term in (" gp", "gross profit", "margin"))
    return mentions_products and mentions_gp and mentions_top_products


def _extract_currency_amount_hint(message: str) -> float | None:
    match = re.search(r"\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b", message)
    if not match:
        return None
    raw = match.group(0).replace(",", "")
    try:
        return float(raw)
    except ValueError:
        return None


def _extract_product_focus_token(message: str) -> str | None:
    t = _normalize_planning_text(message)
    match = re.search(
        r"relating to\s+([a-z0-9][a-z0-9\-\s]{0,48}?)(?=\s*[,\.]|\s+and|\s+then|\s+compare|\s+for|\s*$)",
        t,
    )
    if match:
        return match.group(1).strip()
    match = re.search(r"products?\s+(?:sold\s+)?(?:for|about|like|named)\s+([a-z0-9][a-z0-9\-]{2,40})", t)
    if match:
        return match.group(1).strip()
    match = re.search(r"\b(?:sku|brand|line)\s+([a-z0-9][a-z0-9\-]{2,40})\b", t)
    if match:
        return match.group(1).strip()
    return None


def _looks_like_product_catalog_request(lowered: str) -> bool:
    mentions_products = any(term in lowered for term in ("product", "products", "sku", "skus", "catalog"))
    asks_for_listing = any(
        term in lowered
        for term in (
            "list",
            "show",
            "find",
            "search",
            "matching",
            "match",
            "lookup",
            "look up",
        )
    )
    mentions_order_line = any(term in lowered for term in ("top product", "product sold", "products sold"))
    mentions_finance_math = any(term in lowered for term in ("gross profit", " gp ", "margin", "cogs", "revenue"))
    return mentions_products and asks_for_listing and not mentions_order_line and not mentions_finance_math


def _extract_product_search_query(message: str) -> str | None:
    token = _extract_product_focus_token(message)
    if token:
        return token
    normalized = _normalize_planning_text(message)
    match = re.search(
        r"(?:products?|skus?|catalog)\s+(?:matching|match|named|like|for|about)\s+([a-z0-9][a-z0-9\-\s]{1,48})"
        r"(?=\s*[,\.]|\s+(?:for|from|in|on|during|last|this|today|ytd)\b|\s*$)",
        normalized,
    )
    if not match:
        return None
    captured = match.group(1).strip()
    trailing = re.split(r"\s+for\s+(?:catalog|review|analysis|report)\b", captured, maxsplit=1)
    return trailing[0].strip() if trailing else captured


def _looks_like_sales_order_lookup_request(lowered: str) -> bool:
    has_order_term = any(term in lowered for term in ("sales order", "sale order", "order book", "orders", "order count"))
    has_sales_context = "sales" in lowered or "order" in lowered
    asks_for_lookup = any(
        term in lowered
        for term in (
            "show",
            "list",
            "pull",
            "fetch",
            "find",
            "latest",
            "recent",
            "open",
            "closed",
            "status",
        )
    )
    return has_order_term and has_sales_context and asks_for_lookup


def _dual_odoo_ledger_and_shopify_channel_intent(intent_lowered: str) -> bool:
    """User asked for both core Odoo/ERP ledger-style metrics and Shopify-channel metrics in one message.

    Boilerplate like \"Using Odoo\" + Shopify ROI alone does *not* count as dual — that stays Shopify-primary.
    """
    s = intent_lowered
    if re.search(r"\b(no|not|without|never|except|excluding)\s+shopify\b", s) or "non-shopify" in s:
        return False
    if not _explicit_shopify_channel_finance_intent(intent_lowered):
        return False
    wants_ledger_finance = bool(
        re.search(
            r"\bgp\b|gross profit|gross margin|p&l|profit and loss|ledger|trial balance|balance sheet"
            r"|cost of goods|\bcogs\b|net profit|ebitda",
            s,
        )
    )
    return wants_ledger_finance


def _explicit_shopify_channel_finance_intent(intent_lowered: str) -> bool:
    """True when the user is clearly asking for Shopify-*channel* metrics, not generic Odoo ERP ledger GP."""
    s = intent_lowered
    if re.search(r"\b(no|not|without|never|except|excluding)\s+shopify\b", s) or "non-shopify" in s:
        return False
    if "shopify" not in s:
        return False
    if any(
        p in s
        for p in (
            "shopify roas",
            "shopify roi",
            "shopify marketing",
            "shopify spend",
            "shopify revenue",
            "shopify sales",
            "shopify fees",
            "shopify discount",
            "shopify refunds",
            "shopify channel",
            "shopify-linked",
            "shopify linked",
            "shopify journal",
            "shopify orders",
            "shopify aov",
            "shopify merchant",
            "shopify performance",
            "shopify metrics",
        )
    ):
        return True
    return bool(
        re.search(
            r"\bshopify\b.*\b(roas|roi|marketing|merchant|fee|orders?|aov)\b|\b(roas|roi|marketing|orders?|aov)\b.*\bshopify\b",
            s,
        )
    )


def _plan_odoo_tool_usage(
    message: str,
    *,
    fallback_message: str | None = None,
    intent_message: str | None = None,
) -> dict[str, Any]:
    """Plan Odoo tool usage.

    `message` is the primary text for period/entity extraction (often the latest user turn; may include
    conversation when re-planning with history in `fallback_message`).

    `intent_message` must be the **latest user text only** for channel intent (Shopify/ROAS vs ledger GP).
    Without this, assistant replies that mention \"Shopify\" in the same thread can incorrectly route to
    `odoo.finance.shopify.monthly_roi` when re-planning over full history.
    """
    lowered = _normalize_planning_text(message)
    intent_lowered = _normalize_planning_text(intent_message) if intent_message else lowered
    preview_only = _is_operation_preview_request(message)
    scope = _extract_company_scope(message, fallback_message=fallback_message)
    company_ids = _extract_company_ids(message, fallback_message=fallback_message)
    company_name_terms = _extract_company_name_terms(message, fallback_message=fallback_message)
    scope_lock_fields: dict[str, str] = {}
    lock_canonical = _infer_company_scope_lock_canonical(message, fallback_message)
    if lock_canonical:
        company_name_terms = [lock_canonical]
        scope_lock_fields = {"company_scope_lock": "single_exact", "company_scope_lock_canonical": lock_canonical}

    def _scoped_payload(payload: dict[str, Any]) -> dict[str, Any]:
        if not scope_lock_fields:
            return payload
        merged = dict(payload)
        merged.update(scope_lock_fields)
        return merged

    # Chat history sometimes contains prior "company_id=3,4,5" lists; a strict "Brisbane only" lock must not inherit those.
    if scope_lock_fields and len(company_ids) > 1:
        company_ids = []
    if scope_lock_fields:
        primary_company_ids = _extract_company_ids(message, fallback_message=None)
        if len(primary_company_ids) == 1:
            company_ids = primary_company_ids
        elif not primary_company_ids:
            company_ids = []

    if company_ids:
        scope["company_ids"] = company_ids
        if len(company_ids) == 1:
            scope["company_id"] = company_ids[0]
    period_scope = _extract_period_scope(message)
    month_span = _extract_month_span(message)
    company_list_intent = (
        "company" in lowered
        and (
            re.search(r"\b(list|count|how many|ids?|names?)\b", lowered) is not None
            or "legal entities" in lowered
            or "legal entity" in lowered
        )
    )
    default_plan = {
        "tool_id": "odoo_primary",
        "mode": "none",
        "operation": None,
        "payload": {},
        "reason": "",
        "blocked_reason": None,
        "company_scope": scope,
        "source_labels": [],
        "suppress_retrieval": False,
        "direct_answer": None,
        "multi_step_odoo_hint": None,
    }

    if _dual_odoo_ledger_and_shopify_channel_intent(intent_lowered):
        default_plan["multi_step_odoo_hint"] = (
            "The user asked for both Odoo/ERP ledger-style performance (GP, P&L, etc.) and Shopify-channel "
            "metrics in the same question. These are not mutually exclusive: use multiple governed Odoo operations when "
            "the runtime allows (e.g. ledger margin/revenue/COGS first, then `odoo.finance.shopify.monthly_roi` if they "
            "asked for Shopify ROAS/marketing/Shopify-tagged sales). Label which numbers come from which surface."
        )

    finance_actual_terms = (
        "gross profit",
        " gp ",
        "revenue",
        "cogs",
        "cost of goods",
        "gross margin",
        "financial",
        "profit and loss",
        "p&l",
        "net profit",
        "operating income",
        "total income",
        "total expenses",
    )
    asks_for_actuals = any(term in f" {lowered} " for term in finance_actual_terms) or _looks_like_finance_performance_question(
        lowered
    )
    asks_for_pnl = any(
        term in lowered
        for term in (
            "profit and loss",
            "p&l",
            "net profit",
            "operating income",
            "total income",
            "total expenses",
            "expenses",
            "depreciation",
        )
    )
    has_period = bool(period_scope.get("date_from") and period_scope.get("date_to"))
    derived_month_count = int(period_scope.get("month_count") or 0) if period_scope.get("month_count") else None
    # Shopify helper is *narrow*: Shopify-linked journal ROAS/marketing. Do NOT pair the word "shopify" with
    # loose tokens like "sale" or "revenue" — that routed generic Odoo ERP questions to the wrong op.
    asks_for_shopify_roi = _explicit_shopify_channel_finance_intent(intent_lowered)
    asks_for_cogs_scope = any(
        term in lowered
        for term in (
            "cogs",
            "cost of goods",
            "gross profit",
            "gross margin",
            "margin",
        )
    )
    asks_for_runway = any(
        term in lowered
        for term in (
            "cash runway",
            "runway",
            "cash position",
            "burn rate",
            "cash burn",
        )
    )
    asks_for_dynamic_odoo_query = any(
        term in lowered
        for term in (
            "dynamic",
            "custom query",
            "ad hoc query",
            "query spec",
            "large request",
            "deep dive",
        )
    )
    asks_for_cogs_code_breakdown = any(
        term in lowered
        for term in (
            "cogs code",
            "cogs codes",
            "cost code",
            "cost codes",
        )
    ) or (
        asks_for_cogs_scope
        and any(
            term in lowered
            for term in (
                "account code",
                "account codes",
            )
        )
    )
    has_comparative_intent = any(term in lowered for term in ("compare", "across", "versus", "vs", "anomal", "outlier"))
    asks_for_branch_ranking = _looks_like_branch_ranking_request(lowered)
    asks_for_sales_drilldown = _looks_like_sales_drilldown_request(lowered)
    asks_for_top_products_gp = _looks_like_top_products_gp_request(lowered)
    asks_for_product_catalog = _looks_like_product_catalog_request(lowered)
    asks_for_sales_order_lookup = _looks_like_sales_order_lookup_request(lowered)
    asks_for_bp_scorecard = (
        "burleigh" in lowered
        and "brisbane" in lowered
        and "roas" in lowered
        and any(term in lowered for term in ("cogs", "cost of goods"))
        and any(term in lowered for term in ("gp", "gross profit"))
        and "revenue" in lowered
        and "net" in lowered
    )
    revenue_hint = _extract_currency_amount_hint(message)
    product_explore_token = _extract_product_focus_token(message)
    if asks_for_bp_scorecard:
        bp_payload: dict[str, Any] = {
            "company_name_terms": ["burleigh", "brisbane"],
            "required_metrics": ["cogs", "gp", "revenue", "net", "roas"],
        }
        if has_period:
            bp_payload["date_from"] = period_scope["date_from"]
            bp_payload["date_to"] = period_scope["date_to"]
            bp_payload["relative_period"] = period_scope.get("relative_period")
        else:
            today = date.today()
            bp_payload["date_from"] = date(today.year, today.month, 1).isoformat()
            bp_payload["date_to"] = (today + timedelta(days=1)).isoformat()
            bp_payload["relative_period"] = "month_to_date"
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.finance.pnl.period_summary",
            "payload": _scoped_payload(bp_payload),
            "reason": (
                "BP scorecard prompt requests branch comparison across Burleigh and Brisbane "
                "for COGS/GP/Revenue/Net and ROAS. Use the governed Odoo P&L period summary "
                "so Net Profit and other P&L totals are sourced directly from posted ledger lines."
            ),
            "blocked_reason": None,
            "source_labels": ["odoo", "finance", "bp_mode"],
            "suppress_retrieval": True,
            "multi_step_odoo_hint": (
                "Run odoo.finance.pnl.period_summary first for all P&L-backed metrics, then "
                "odoo.finance.shopify.monthly_roi if channel-specific Shopify ROAS is required."
            ),
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.finance.pnl.period_summary",
                    payload=_scoped_payload(bp_payload),
                    why_correct=(
                        "This aligns with branch-level scorecard requests that include Net Profit and "
                        "requires direct Odoo Profit & Loss grounding rather than margin-only helpers."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot produce branch-level P&L metrics including Net Profit."
                    ),
                )
                if preview_only
                else None
            ),
        }
    if asks_for_pnl and has_period:
        pnl_payload: dict[str, Any] = {
            "date_from": period_scope["date_from"],
            "date_to": period_scope["date_to"],
            "relative_period": period_scope["relative_period"],
        }
        if company_ids:
            if len(company_ids) == 1:
                pnl_payload["company_id"] = company_ids[0]
            else:
                pnl_payload["company_ids"] = company_ids
        elif len(company_name_terms) >= 1:
            pnl_payload["company_name_terms"] = company_name_terms
        elif scope.get("company_id") is not None:
            pnl_payload["company_id"] = scope["company_id"]
        blocked_reason = (
            "company_scope_ambiguous"
            if scope.get("ambiguous")
            and not pnl_payload.get("company_id")
            and not pnl_payload.get("company_ids")
            and not pnl_payload.get("company_name_terms")
            else None
        )
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.finance.pnl.period_summary",
            "payload": _scoped_payload(pnl_payload),
            "reason": (
                "P&L/Net Profit prompts must use the governed Odoo P&L helper so operating income, "
                "cost of revenue, total expenses, and net profit are all derived from posted ledger lines."
            ),
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo", "finance", "pnl"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.finance.pnl.period_summary",
                    payload=_scoped_payload(pnl_payload),
                    why_correct=(
                        "This is correct because P&L questions require a direct Profit & Loss extraction from Odoo, "
                        "not a gross-margin-only shortcut."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot return Net Profit or any period P&L statement totals."
                    ),
                )
                if preview_only
                else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
            ),
        }
    if (
        product_explore_token
        and _looks_like_product_branch_exploration(lowered)
        and len(company_name_terms) >= 2
    ):
        explore_payload: dict[str, Any] = {
            "product_name_substring": product_explore_token,
            "company_name_terms": company_name_terms,
        }
        if has_period:
            explore_payload["date_from"] = period_scope["date_from"]
            explore_payload["date_to"] = period_scope["date_to"]
            explore_payload["relative_period"] = period_scope.get("relative_period")
        else:
            today = date.today()
            explore_payload["date_from"] = date(today.year, 1, 1).isoformat()
            explore_payload["date_to"] = (today + timedelta(days=1)).isoformat()
            explore_payload["relative_period"] = "exploration_default_ytd"
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.exploration.product_branch_sales",
            "payload": _scoped_payload(explore_payload),
            "reason": (
                "Product + multi-branch comparison prompts should run the governed multi-step exploration operation "
                "(catalog match, then sale.order.line aggregation by company) instead of a single static finance script."
            ),
            "blocked_reason": None,
            "source_labels": ["odoo", "exploration"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.exploration.product_branch_sales",
                    payload=_scoped_payload(explore_payload),
                    why_correct=(
                        "This is correct because the question requires discovery over product master data and "
                        "order lines before any branch comparison can be grounded."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot search products or aggregate sales lines across branches."
                    ),
                )
                if preview_only
                else None
            ),
        }
    if asks_for_top_products_gp:
        products_payload: dict[str, Any] = {
            "top_n": 5,
            "can_be_sold": True,
        }
        if has_period:
            products_payload["date_from"] = period_scope["date_from"]
            products_payload["date_to"] = period_scope["date_to"]
            products_payload["relative_period"] = period_scope.get("relative_period")
        else:
            today = date.today()
            products_payload["date_from"] = date(today.year, today.month, 1).isoformat()
            products_payload["date_to"] = (today + timedelta(days=1)).isoformat()
            products_payload["relative_period"] = "month_to_date"
        if company_ids:
            if len(company_ids) == 1:
                products_payload["company_id"] = company_ids[0]
        elif scope.get("company_id") is not None:
            products_payload["company_id"] = scope["company_id"]
        elif len(company_name_terms) == 1:
            products_payload["company_name_terms"] = company_name_terms
        if revenue_hint is not None:
            products_payload["revenue_reference_total"] = revenue_hint
        blocked_reason = (
            "company_scope_ambiguous"
            if scope.get("ambiguous")
            and products_payload.get("company_id") is None
            and not products_payload.get("company_name_terms")
            else None
        )
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.sales.products_gp.period_top",
            "payload": _scoped_payload(products_payload),
            "reason": (
                "Top-products plus GP questions should use the named product GP helper with `can_be_sold` filtering, "
                "rather than ad hoc ledger summaries."
            ),
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo", "sales", "products"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.sales.products_gp.period_top",
                    payload=_scoped_payload(products_payload),
                    why_correct=(
                        "This is correct because ranking products and computing per-product GP requires product-level "
                        "sale line aggregation with explicit filter controls."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot rank sold products or compute product-level GP."
                    ),
                )
                if preview_only
                else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
            ),
        }
    if asks_for_sales_drilldown:
        if has_period:
            drill_payload: dict[str, Any] = {
                "date_from": period_scope["date_from"],
                "date_to": period_scope["date_to"],
                "relative_period": period_scope["relative_period"],
            }
        else:
            today = date.today()
            drill_payload = {
                "date_from": date(today.year, today.month, 1).isoformat(),
                "date_to": (today + timedelta(days=1)).isoformat(),
                "relative_period": "month_to_date",
            }
        if company_ids:
            if len(company_ids) == 1:
                drill_payload["company_id"] = company_ids[0]
        elif scope.get("company_id") is not None:
            drill_payload["company_id"] = scope["company_id"]
        elif len(company_name_terms) == 1:
            drill_payload["company_name_terms"] = company_name_terms
        blocked_reason = (
            "company_scope_ambiguous"
            if scope.get("ambiguous")
            and drill_payload.get("company_id") is None
            and not drill_payload.get("company_name_terms")
            else None
        )
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.sales.drilldown.period",
            "payload": _scoped_payload(drill_payload),
            "reason": (
                "Sales drill-down questions should use the named operation that returns top sales agent, payment method, "
                "and product for the requested period."
            ),
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo", "sales"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.sales.drilldown.period",
                    payload=_scoped_payload(drill_payload),
                    why_correct=(
                        "This is correct because drill-downs require multiple governed aggregations over orders, order lines, "
                        "and payment records to identify leaders within the selected date range."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot aggregate top sales agents, products, or payment methods."
                    ),
                )
                if preview_only
                else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
            ),
        }
    if asks_for_product_catalog:
        product_payload: dict[str, Any] = {
            "can_be_sold": True,
            "limit": 50,
            "fields": ["id", "name", "default_code", "list_price", "qty_available", "sale_ok"],
        }
        product_query = _extract_product_search_query(message)
        if product_query:
            product_payload["query"] = product_query
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.products.search_read",
            "payload": _scoped_payload(product_payload),
            "reason": "Product discovery/listing requests should use the governed product search helper.",
            "blocked_reason": None,
            "source_labels": ["odoo", "products"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.products.search_read",
                    payload=_scoped_payload(product_payload),
                    why_correct=(
                        "This is correct because product catalog lookups require `product.template` reads with controlled fields "
                        "and optional name/default-code matching."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot return product catalog records or SKU-level search results."
                    ),
                )
                if preview_only
                else None
            ),
        }
    if asks_for_sales_order_lookup and has_period:
        domain: list[list[Any]] = [
            ["date_order", ">=", period_scope["date_from"]],
            ["date_order", "<", period_scope["date_to"]],
            ["state", "in", ["sale", "done"]],
        ]
        if scope.get("company_id") is not None:
            domain.append(["company_id", "=", scope["company_id"]])
        blocked_reason = "company_scope_ambiguous" if scope.get("ambiguous") and scope.get("company_id") is None else None
        sales_payload: dict[str, Any] = {
            "domain": domain,
            "limit": 100,
            "fields": ["id", "name", "state", "partner_id", "company_id", "date_order", "amount_total", "currency_id"],
        }
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.sales.orders.search_read",
            "payload": _scoped_payload(sales_payload),
            "reason": "Period order-book requests should use governed sale.order search_read with explicit date scope.",
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo", "sales"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.sales.orders.search_read",
                    payload=_scoped_payload(sales_payload),
                    why_correct=(
                        "This is correct because order-level sales checks need direct `sale.order` retrieval for the requested "
                        "period and company scope."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot list period-scoped sales orders, totals, and order statuses."
                    ),
                )
                if preview_only
                else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
            ),
        }
    # Dual Odoo+Shopify: prefer ledger/GP path first (below); Shopify-only shortcut would hide margin/GP.
    route_shopify_only = asks_for_shopify_roi and has_period and not _dual_odoo_ledger_and_shopify_channel_intent(
        intent_lowered
    )
    if route_shopify_only:
        payload: dict[str, Any] = {
            "date_from": period_scope["date_from"],
            "date_to": period_scope["date_to"],
            "relative_period": period_scope["relative_period"],
        }
        if company_ids:
            if len(company_ids) == 1:
                payload["company_id"] = company_ids[0]
            else:
                payload["company_ids"] = company_ids
        elif len(company_name_terms) >= 1:
            payload["company_name_terms"] = company_name_terms
        elif scope.get("company_id") is not None:
            payload["company_id"] = scope["company_id"]
        blocked_reason = (
            "company_scope_ambiguous"
            if scope.get("ambiguous") and not payload.get("company_id") and not payload.get("company_ids") and not payload.get("company_name_terms")
            else None
        )
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.finance.shopify.monthly_roi",
            "payload": _scoped_payload(payload),
            "reason": (
                "Shopify revenue, discounts, refunds, shipping, merchant fees, and marketing-spend ROI questions "
                "should use the named Shopify monthly ROI helper for the requested company scope and period."
            ),
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.finance.shopify.monthly_roi",
                    payload=_scoped_payload(payload),
                    why_correct=(
                        "This is correct because Shopify ROI requires one governed Odoo result that combines Shopify-linked "
                        "revenue and fee accounts with marketing expense accounts and vendor-ledger evidence."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot identify Shopify journals, marketing accounts, or compute ROAS."
                    ),
                )
                if preview_only
                else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
            ),
        }
    if asks_for_cogs_code_breakdown and has_period:
        payload = {
            "date_from": period_scope["date_from"],
            "date_to": period_scope["date_to"],
            "months": derived_month_count or 1,
            "top_n": 8,
        }
        if company_ids:
            if len(company_ids) == 1:
                payload["company_id"] = company_ids[0]
            else:
                payload["company_ids"] = company_ids
        elif scope.get("company_id") is not None:
            payload["company_id"] = scope["company_id"]
        blocked_reason = "company_scope_ambiguous" if scope.get("ambiguous") and scope.get("company_id") is None else None
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.finance.cogs.monthly_code_breakdown",
            "payload": _scoped_payload(payload),
            "reason": (
                "COGS code questions should use a governed monthly code breakdown over direct-cost move lines for the exact requested period "
                f"({period_scope['label']})."
            ),
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.finance.cogs.monthly_code_breakdown",
                    payload=_scoped_payload(payload),
                    why_correct=(
                        "This is correct because COGS-code analysis needs grouped direct-cost balances from "
                        "`account.move.line`, broken out by month and account code for the requested period."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` only confirms the authenticated user context. It cannot return the "
                        "COGS account-code balances needed to diagnose a GP anomaly."
                    ),
                )
                if preview_only
                else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
            ),
        }
    if asks_for_actuals and (month_span or derived_month_count) and len(company_ids) > 1:
        payload: dict[str, Any] = {
            "months": month_span or derived_month_count,
            "include_current_month": False,
            "company_ids": company_ids,
        }
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.finance.margin.monthly_comparison",
            "payload": _scoped_payload(payload),
            "reason": (
                "Multi-company monthly GP questions should use the named monthly comparison helper "
                f"across companies {', '.join(str(company_id) for company_id in company_ids)}."
            ),
            "source_labels": ["odoo"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.finance.margin.monthly_comparison",
                    payload=_scoped_payload(payload),
                    why_correct=(
                        "This is correct because a multi-company GP comparison needs monthly revenue and COGS by company, "
                        "plus company-name resolution, in one governed Odoo-backed result."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` can confirm who is authenticated, but it cannot deliver the monthly "
                        "revenue, COGS, GP, and anomaly inputs needed for a CFO-grade comparison."
                    ),
                )
                if preview_only
                else None
            ),
        }
    if asks_for_actuals and has_period and len(company_name_terms) > 1:
        payload = {
            "date_from": period_scope["date_from"],
            "date_to": period_scope["date_to"],
            "months": month_span or derived_month_count or period_scope.get("month_count") or 4,
            "company_name_terms": company_name_terms,
        }
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.finance.margin.monthly_comparison",
            "payload": _scoped_payload(payload),
            "reason": (
                "Named multi-business YTD and performance questions should resolve company names first, then run the "
                "governed monthly margin comparison helper across the matched companies."
            ),
            "source_labels": ["odoo"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.finance.margin.monthly_comparison",
                    payload=_scoped_payload(payload),
                    why_correct=(
                        "This is correct because the question asks for a grounded cross-business performance comparison, "
                        "which requires resolving the named companies and then comparing monthly revenue, COGS, GP, and GP%."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot resolve the named companies or produce the finance comparison "
                        "needed to identify the performer."
                    ),
                )
                if preview_only
                else None
            ),
        }
    if (
        has_period
        and len(company_name_terms) > 1
        and (asks_for_branch_ranking or has_comparative_intent or asks_for_actuals)
    ):
        payload = {
            "date_from": period_scope["date_from"],
            "date_to": period_scope["date_to"],
            "months": month_span or derived_month_count or period_scope.get("month_count") or 4,
            "company_name_terms": company_name_terms,
        }
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.finance.margin.monthly_comparison",
            "payload": _scoped_payload(payload),
            "reason": (
                "Branch ranking/comparison questions across multiple named businesses should execute the governed "
                "monthly margin comparison helper over the resolved company scope."
            ),
            "source_labels": ["odoo"],
            "suppress_retrieval": True,
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.finance.margin.monthly_comparison",
                    payload=_scoped_payload(payload),
                    why_correct=(
                        "This is correct because branch/entity ranking requires side-by-side monthly revenue, COGS, GP, and GP% "
                        "across the named businesses in the requested period."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot produce comparative branch/entity profitability rankings."
                    ),
                )
                if preview_only
                else None
            ),
        }

    if company_list_intent and not asks_for_actuals:
        payload = {
            "model": "res.company",
            "domain": [],
            "fields": ["id", "name"],
            "limit": 100,
            "offset": 0,
            "order": "name asc",
        }
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.rpc.search_read",
            "payload": _scoped_payload(payload),
            "reason": "List company identifiers and canonical company names directly from `res.company`.",
            "source_labels": ["odoo"],
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.rpc.search_read",
                    payload=_scoped_payload(payload),
                    why_correct=(
                        "This is correct because `res.company` is the authoritative Odoo model for companies, "
                        "and `search_read` returns exactly the company IDs and names needed with explicit fields."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` is insufficient because it is a user-context check, not an "
                        "authoritative company-list endpoint. It can confirm the authenticated user and current "
                        "company context, but it does not reliably enumerate the full set of accessible company "
                        "records with canonical names."
                    ),
                )
                if preview_only
                else None
            ),
        }
    if asks_for_actuals and has_period:
        payload: dict[str, Any] = {
            "date_from": period_scope["date_from"],
            "date_to": period_scope["date_to"],
            "relative_period": period_scope["relative_period"],
        }
        if scope.get("company_id") is not None:
            payload["company_id"] = scope["company_id"]
        elif len(company_name_terms) == 1:
            payload["company_name_terms"] = company_name_terms
        blocked_reason = "company_scope_ambiguous" if scope.get("ambiguous") and scope.get("company_id") is None else None
        if asks_for_dynamic_odoo_query:
            query_spec_domain: list[list[Any]] = [
                ["parent_state", "=", "posted"],
                ["date", ">=", period_scope["date_from"]],
                ["date", "<", period_scope["date_to"]],
            ]
            if payload.get("company_id") is not None:
                query_spec_domain.append(["company_id", "=", payload["company_id"]])
            query_spec = {
                "model": "account.move.line",
                "method": "read_group",
                "domain": query_spec_domain,
                "fields": ["balance:sum"],
                "groupby": ["company_id", "date:month", "account_id"],
                "orderby": "date:month asc",
                "lazy": False,
            }
            dynamic_payload = dict(payload)
            dynamic_payload["query_spec"] = query_spec
            return {
                **default_plan,
                "mode": "preview" if preview_only else "required",
                "operation": "odoo.rpc.query_spec",
                "payload": _scoped_payload(dynamic_payload),
                "reason": (
                    "Dynamic large-scope finance requests should compile to a governed Odoo query spec so the model can "
                    "adapt grouping without using raw SQL."
                ),
                "blocked_reason": blocked_reason,
                "source_labels": ["odoo"],
                "suppress_retrieval": True,
                "direct_answer": (
                    _build_odoo_preview_answer(
                        operation="odoo.rpc.query_spec",
                        payload=_scoped_payload(dynamic_payload),
                        why_correct=(
                            "This is correct because the request needs dynamic grouping over a broad period and should "
                            "execute via a validated Odoo query spec contract."
                        ),
                        why_meta_current_user_is_insufficient=(
                            "`odoo.meta.current_user` cannot execute grouped financial data retrieval."
                        ),
                    )
                    if preview_only
                    else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
                ),
            }
        if asks_for_runway:
            return {
                **default_plan,
                "mode": "preview" if preview_only else "required",
                "operation": "odoo.finance.cash.runway_summary",
                "payload": _scoped_payload(payload),
                "reason": (
                    "Cash runway prompts should execute the cash runway summary helper so revenue/COGS/GP and runway "
                    "math are derived from the same governed Odoo period scope."
                ),
                "blocked_reason": blocked_reason,
                "source_labels": ["odoo"],
                "direct_answer": (
                    _build_odoo_preview_answer(
                        operation="odoo.finance.cash.runway_summary",
                        payload=_scoped_payload(payload),
                        why_correct=(
                            "This is correct because runway questions need period financial actuals plus a governed "
                            "cash-position and burn-rate calculation."
                        ),
                        why_meta_current_user_is_insufficient=(
                            "`odoo.meta.current_user` cannot produce revenue, COGS, GP, cash balance, burn rate, or runway."
                        ),
                    )
                    if preview_only
                    else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
                ),
            }
        if any(term in lowered for term in ("gross profit", " gp ", "gross margin")) or re.search(
            r"\bgp\b", lowered
        ):
            return {
                **default_plan,
                "mode": "preview" if preview_only else "required",
                "operation": "odoo.finance.margin.period_summary",
                "payload": _scoped_payload(payload),
                "reason": f"Period GP questions should use the named period summary helper for {period_scope['label']}.",
                "blocked_reason": blocked_reason,
                "source_labels": ["odoo"],
                "direct_answer": (
                    _build_odoo_preview_answer(
                        operation="odoo.finance.margin.period_summary",
                        payload=_scoped_payload(payload),
                        why_correct=(
                            "This is correct because period GP should be derived from Odoo-backed revenue and COGS for the "
                            f"exact requested date window ({period_scope['label']}) and company scope."
                        ),
                        why_meta_current_user_is_insufficient=(
                            "`odoo.meta.current_user` can confirm user/company context, but it cannot provide the revenue, "
                            "COGS, or GP totals required for a month-end finance answer."
                        ),
                    )
                    if preview_only
                    else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
                ),
            }
        if _looks_like_mixed_finance_period_request(lowered=lowered, asks_for_cogs_scope=asks_for_cogs_scope):
            return {
                **default_plan,
                "mode": "preview" if preview_only else "required",
                "operation": "odoo.finance.margin.period_summary",
                "payload": _scoped_payload(payload),
                "reason": (
                    "Mixed period-finance prompts mentioning revenue with margin/COGS should use period summary so "
                    "the owner gets revenue, COGS, and GP in one governed response."
                ),
                "blocked_reason": blocked_reason,
                "source_labels": ["odoo"],
                "direct_answer": (
                    _build_odoo_preview_answer(
                        operation="odoo.finance.margin.period_summary",
                        payload=_scoped_payload(payload),
                        why_correct=(
                            "This is correct because mixed finance reality questions require the combined period totals "
                            "for revenue, COGS, gross profit, and gross margin."
                        ),
                        why_meta_current_user_is_insufficient=(
                            "`odoo.meta.current_user` cannot provide combined period financial totals for a decisive "
                            "owner-operator answer."
                        ),
                    )
                    if preview_only
                    else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
                ),
            }
        if "revenue" in lowered:
            return {
                **default_plan,
                "mode": "preview" if preview_only else "required",
                "operation": "odoo.finance.revenue.period",
                "payload": _scoped_payload(payload),
                "reason": f"Period revenue questions should use the named period revenue helper for {period_scope['label']}.",
                "blocked_reason": blocked_reason,
                "source_labels": ["odoo"],
                "direct_answer": _build_scope_clarification_answer(scope, message) if blocked_reason else None,
            }
        if any(term in lowered for term in ("cogs", "cost of goods")):
            return {
                **default_plan,
                "mode": "preview" if preview_only else "required",
                "operation": "odoo.finance.cogs.period",
                "payload": _scoped_payload(payload),
                "reason": f"Period COGS questions should use the named period COGS helper for {period_scope['label']}.",
                "blocked_reason": blocked_reason,
                "source_labels": ["odoo"],
                "direct_answer": _build_scope_clarification_answer(scope, message) if blocked_reason else None,
            }
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.finance.margin.period_summary",
            "payload": _scoped_payload(payload),
            "reason": (
                "General finance reality and real-time BI prompts should default to the governed period margin summary "
                "when no narrower metric-specific operation is explicitly requested."
            ),
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo"],
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.finance.margin.period_summary",
                    payload=_scoped_payload(payload),
                    why_correct=(
                        "This is correct because owner-operator finance reality requires the core period totals "
                        "(revenue, COGS, GP, GP%) from a governed Odoo-backed summary."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` cannot provide the business financial reality metrics required for "
                        "a decision-grade BI view."
                    ),
                )
                if preview_only
                else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
            ),
        }

    quarterly_margin_terms = ("quarter", "quarterly")
    margin_terms = ("gross margin", "margin", "gross profit", "cogs", "revenue")
    if any(term in lowered for term in quarterly_margin_terms) and any(term in lowered for term in margin_terms):
        payload: dict[str, Any] = {"quarters": 4, "include_current_quarter": False}
        if scope.get("company_id") is not None:
            payload["company_id"] = scope["company_id"]
        blocked_reason = "company_scope_ambiguous" if scope.get("ambiguous") and scope.get("company_id") is None else None
        return {
            **default_plan,
            "mode": "preview" if preview_only else "required",
            "operation": "odoo.finance.margin.quarterly_summary",
            "payload": _scoped_payload(payload),
            "reason": "Quarterly board-style revenue, COGS, GP, and GP% summary is best served by the named margin helper.",
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo"],
            "direct_answer": (
                _build_odoo_preview_answer(
                    operation="odoo.finance.margin.quarterly_summary",
                    payload=_scoped_payload(payload),
                    why_correct=(
                        "This is the best first operation because it returns the board-level quarterly revenue, "
                        "COGS, gross profit, and gross margin outputs directly in grouped summary form."
                    ),
                    why_meta_current_user_is_insufficient=(
                        "`odoo.meta.current_user` only validates the user and current company context. It does not "
                        "produce quarterly finance summaries or diagnose margin compression on its own."
                    ),
                )
                if preview_only
                else (_build_scope_clarification_answer(scope, message) if blocked_reason else None)
            ),
        }

    if "receivable" in lowered or "accounts receivable" in lowered:
        payload = {"limit": 20}
        if scope.get("company_id") is not None:
            payload["domain"] = [["company_id", "=", scope["company_id"]]]
        blocked_reason = "company_scope_ambiguous" if scope.get("ambiguous") and scope.get("company_id") is None else None
        return {
            **default_plan,
            "mode": "required",
            "operation": "odoo.finance.receivables.open",
            "payload": _scoped_payload(payload),
            "reason": "Use the named receivables helper for open AR exposure rather than broad invoice listing.",
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo"],
            "direct_answer": _build_scope_clarification_answer(scope, message) if blocked_reason else None,
        }

    if "invoice" in lowered:
        payload = {"limit": 20}
        if scope.get("company_id") is not None:
            payload["domain"] = [["company_id", "=", scope["company_id"]]]
        blocked_reason = "company_scope_ambiguous" if scope.get("ambiguous") and scope.get("company_id") is None else None
        return {
            **default_plan,
            "mode": "required",
            "operation": "odoo.finance.invoices.search_read",
            "payload": _scoped_payload(payload),
            "reason": "Use the named invoice helper for customer invoice retrieval.",
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo"],
            "direct_answer": _build_scope_clarification_answer(scope, message) if blocked_reason else None,
        }

    if "sales order" in lowered or "sale order" in lowered or "order book" in lowered:
        payload = {"limit": 20}
        if scope.get("company_id") is not None:
            payload["domain"] = [["company_id", "=", scope["company_id"]]]
        blocked_reason = "company_scope_ambiguous" if scope.get("ambiguous") and scope.get("company_id") is None else None
        return {
            **default_plan,
            "mode": "required",
            "operation": "odoo.sales.orders.search_read",
            "payload": _scoped_payload(payload),
            "reason": "Use the named sales-order helper for operational order-book questions.",
            "blocked_reason": blocked_reason,
            "source_labels": ["odoo"],
            "direct_answer": _build_scope_clarification_answer(scope, message) if blocked_reason else None,
        }

    if "current user" in lowered or "who am i" in lowered:
        return {
            **default_plan,
            "mode": "required",
            "operation": "odoo.meta.current_user",
            "payload": _scoped_payload({}),
            "reason": "Use the current-user helper for auth and current company context checks.",
            "source_labels": ["odoo"],
        }

    return default_plan


def select_semantic_target_document(message: str, semantic_hits: list[dict[str, Any]]) -> dict[str, Any] | None:
    documents = _summarize_semantic_documents(semantic_hits)
    if not documents:
        return None

    for document in documents:
        filename = str(document.get("filename") or "")
        if filename and _message_mentions_filename(message, filename):
            return {**document, "selection_reason": "filename_mention"}

    total_hits = sum(int(document["hit_count"]) for document in documents)
    if total_hits < DOCUMENT_DOMINANCE_MIN_HITS:
        return None

    top_document = documents[0]
    if int(top_document["hit_count"]) == total_hits:
        return {**top_document, "selection_reason": "document_dominance"}

    if len(documents) < 2:
        return None

    second_document = documents[1]
    total_score = sum(float(document["score_sum"]) for document in documents)
    hit_share = int(top_document["hit_count"]) / max(total_hits, 1)
    score_share = float(top_document["score_sum"]) / total_score if total_score > 0 else 0.0
    if (
        int(top_document["hit_count"]) >= DOCUMENT_DOMINANCE_MIN_HITS
        and hit_share >= DOCUMENT_DOMINANCE_MIN_SHARE
        and score_share >= DOCUMENT_DOMINANCE_MIN_SCORE_SHARE
        and int(top_document["hit_count"]) >= int(second_document["hit_count"]) + DOCUMENT_DOMINANCE_MIN_GAP
    ):
        return {**top_document, "selection_reason": "document_dominance"}
    return None


def build_query_plan(
    message: str,
    corpora: list[str],
    top_k: int,
    trace_id: str,
    current_message: str | None = None,
    workflow_mode: str | None = None,
    embedding_model_id: str | None = None,
    kb_enabled: bool = True,
    odoo_ready: bool = False,
) -> dict[str, Any]:
    user_message = (current_message or message).strip()
    with SessionLocal() as session:
        connection = get_active_connection(session, "openai")
        if not embedding_model_id:
            kb_config = dict(get_default_runtime_profile(session).kb_config_json or {})
            embedding_model_id = kb_config.get("embedding_model_id")
        mode = classify_query_mode(user_message)
        tool_plan = _plan_odoo_tool_usage(user_message, fallback_message=message, intent_message=user_message)
        if (
            str(tool_plan.get("mode") or "none") == "none"
            and message.strip()
            and message.strip() != user_message
        ):
            history_aware_tool_plan = _plan_odoo_tool_usage(
                message,
                fallback_message=user_message,
                intent_message=user_message,
            )
            if str(history_aware_tool_plan.get("mode") or "none") != "none":
                tool_plan = history_aware_tool_plan
        resolved_workflow_mode = str(workflow_mode or "standard").strip().casefold() or "standard"
        if resolved_workflow_mode == "odoo_specialist":
            tool_plan["source_labels"] = sorted({"odoo", *list(tool_plan.get("source_labels") or [])})
            if str(tool_plan.get("mode") or "none") != "none" and odoo_ready:
                tool_plan["suppress_retrieval"] = True
        suppress_retrieval = bool(tool_plan.get("suppress_retrieval"))
        if str(tool_plan.get("tool_id") or "") == "odoo_primary" and not odoo_ready:
            suppress_retrieval = False
        if not kb_enabled:
            suppress_retrieval = True
        citations: list[dict[str, Any]] = []
        direct_answer: str | None = None
        if tool_plan.get("direct_answer"):
            direct_answer = str(tool_plan["direct_answer"])
        inventory_query = kb_enabled and needs_document_inventory_context(user_message)
        inventory_listing_query = is_document_inventory_listing_question(user_message)
        inventory_documents = select_documents_for_corpora(session, corpora) if inventory_query else []
        inventory_context = build_document_inventory_context(inventory_documents) if inventory_query else ""
        if inventory_query:
            if inventory_documents:
                citations.extend(build_document_inventory_citations(inventory_documents))
            if inventory_listing_query:
                return {
                    "query_mode": mode,
                    "direct_answer": build_document_inventory_answer(inventory_documents, corpora),
                    "prompt": None,
                    "citations": citations,
                    "tool_plan": tool_plan,
                    "evidence_bundle": {
                        "source_labels": ["kb"],
                        "retrieval_citation_count": len(citations),
                    },
                }
        structured_candidates = (
            find_structured_candidates(user_message, corpora)
            if (kb_enabled and mode in {"structured", "blended"} and not suppress_retrieval)
            else []
        )
        structured_context: list[str] = []
        if structured_candidates:
            target_field = None
            top_row_json = structured_candidates[0]["row"].row_json
            for key in top_row_json:
                key_terms = [key.casefold(), key.replace("_", " ").casefold()]
                if any(re.search(rf"\b{re.escape(term)}\b", user_message.lower()) for term in key_terms):
                    target_field = key
                    break
            for candidate in structured_candidates:
                row = candidate["row"]
                table = candidate["table"]
                sheet = candidate["sheet"]
                document = candidate["document"]
                structured_context.append(
                    build_row_artifact_text(
                        filename=document.filename,
                        sheet_name=sheet.name,
                        table_name=table.name,
                        row_index=row.row_index,
                        row_json=row.row_json,
                    )
                )
                citations.append(
                    {
                        "document_id": document.id,
                        "filename": document.filename,
                        "corpus": document.corpus,
                        "artifact_type": "row_summary",
                        "source_path": document.source_path,
                        "sheet_name": sheet.name,
                        "table_name": table.name,
                        "row_index": row.row_index,
                    }
                )
            if target_field and target_field in top_row_json and mode == "structured" and len(user_message.split()) <= 20:
                value = top_row_json.get(target_field, "")
                top = structured_candidates[0]
                direct_answer = (
                    f"{target_field.replace('_', ' ').title()} is {value} "
                    f"(sheet {top['sheet'].name}, table {top['table'].name}, row {top['row'].row_index})."
                )

        semantic_context: list[str] = []
        document_scoped_context: list[str] = []
        target_document: dict[str, Any] | None = None
        if kb_enabled and (mode in {"semantic", "blended"} or not direct_answer) and not suppress_retrieval:
            query_vectors = embed_texts(
                [user_message],
                connection,
                embedding_model=embedding_model_id,
                trace_id=trace_id,
                service="workflow-runtime",
            )
            if query_vectors:
                semantic_hits = search_vectors(
                    query_vectors[0],
                    corpora,
                    top_k,
                    trace_id=trace_id,
                    service="workflow-runtime",
                )
                prompt_semantic_hits = semantic_hits
                if mode in {"semantic", "blended"}:
                    target_document = select_semantic_target_document(user_message, semantic_hits)
                if (
                    target_document is not None
                    and str(target_document.get("selection_reason")) == "filename_mention"
                ):
                    prompt_semantic_hits = [
                        hit
                        for hit in semantic_hits
                        if str(hit.get("document_id") or "") == str(target_document.get("document_id") or "")
                    ]
                semantic_hit_keys: set[tuple[Any, ...]] = set()
                citation_keys = {_citation_key(citation) for citation in citations}
                semantic_context, semantic_citations = collect_semantic_context_and_citations(
                    prompt_semantic_hits,
                    seen_hit_keys=semantic_hit_keys,
                    seen_citation_keys=citation_keys,
                )
                citations.extend(semantic_citations)
                if target_document is not None:
                    expansion_hits = search_vectors(
                        query_vectors[0],
                        corpora,
                        _document_expansion_limit(top_k),
                        document_ids=[target_document["document_id"]],
                        trace_id=trace_id,
                        service="workflow-runtime",
                    )
                    document_scoped_context, document_scoped_citations = collect_semantic_context_and_citations(
                        expansion_hits,
                        seen_hit_keys=semantic_hit_keys,
                        seen_citation_keys=citation_keys,
                    )
                    citations.extend(document_scoped_citations)

        if direct_answer:
            return {
                "query_mode": mode,
                "direct_answer": direct_answer,
                "prompt": None,
                "citations": citations,
                "tool_plan": tool_plan,
                "evidence_bundle": {
                    "source_labels": sorted({"kb", *list(tool_plan.get("source_labels") or [])}) if citations else list(tool_plan.get("source_labels") or []),
                    "retrieval_citation_count": len(citations),
                },
            }

        all_context = []
        if inventory_context:
            all_context.append(inventory_context)
        if structured_context:
            all_context.append("Structured lookup candidates:\n" + "\n".join(structured_context))
        if semantic_context:
            all_context.append("Semantic retrieval candidates:\n" + "\n".join(semantic_context))
        if document_scoped_context and target_document is not None:
            all_context.append(
                "Document-scoped expansion:\n"
                f"Target document: filename={target_document['filename']} | corpus={target_document['corpus']} | "
                f"selection_reason={_document_selection_reason_label(str(target_document['selection_reason']))}\n"
                + "\n".join(document_scoped_context)
            )
        if not all_context:
            if suppress_retrieval or not kb_enabled:
                prompt = f"User question: {user_message}"
            else:
                prompt = (
                    f"User question: {user_message}\n\n"
                    "No matching structured rows or semantic retrieval artifacts were found. "
                    "Say clearly that no grounded answer is available."
                )
        else:
            prompt = (
                "Use only the grounded context below. If the question asks for an exact row value, prefer the "
                "structured lookup evidence first.\n\n"
                + "\n\n".join(all_context)
                + f"\n\nUser question: {user_message}"
            )
        if mode == "structured" and structured_context and semantic_context:
            mode = "blended"
        return {
            "query_mode": mode,
            "direct_answer": None,
            "prompt": prompt,
            "citations": citations,
            "tool_plan": tool_plan,
            "evidence_bundle": {
                "source_labels": sorted({"kb", *list(tool_plan.get("source_labels") or [])}) if citations else list(tool_plan.get("source_labels") or []),
                "retrieval_citation_count": len(citations),
            },
        }


class QueryWorkflow(Workflow):
    @step
    async def prepare_query(self, ev: StartEvent) -> StopEvent:
        result = build_query_plan(
            message=str(start_event_value(ev, "message")),
            current_message=str(start_event_value(ev, "current_message") or start_event_value(ev, "message")),
            corpora=list(start_event_value(ev, "corpora") or []),
            top_k=int(start_event_value(ev, "top_k") or 6),
            trace_id=str(start_event_value(ev, "trace_id")),
            workflow_mode=str(start_event_value(ev, "workflow_mode") or "standard"),
            embedding_model_id=str(start_event_value(ev, "embedding_model_id") or "") or None,
            kb_enabled=bool(start_event_value(ev, "kb_enabled", default=True)),
            odoo_ready=bool(start_event_value(ev, "odoo_ready", default=False)),
        )
        return StopEvent(result=result)
