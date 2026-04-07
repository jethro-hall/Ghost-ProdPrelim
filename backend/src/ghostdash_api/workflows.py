from __future__ import annotations

import hashlib
import json
import mimetypes
import re
from datetime import UTC, datetime
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


def select_documents_for_corpus(session, corpus: str) -> list[DocumentRecord]:
    return list(
        session.scalars(
            select(DocumentRecord)
            .where(DocumentRecord.corpus == corpus)
            .order_by(DocumentRecord.updated_at.desc())
        )
    )


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
                document.requested_lane = document.requested_lane or settings.app_default_policy_lane
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
                        sheet_count, table_count, row_count, _ = structure.get("sheet_count", 0), 0, 0, None
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
                            document.metadata_json = {
                                "artifact_count": len(retrieval_artifacts),
                                "page_count": pdf_extraction.page_count,
                                "total_text_chars": pdf_extraction.total_text_chars,
                                "pdf_chunk_size": pdf_config.chunk_size,
                                "pdf_chunk_overlap": pdf_config.chunk_overlap,
                                "pdf_sentence_window": pdf_config.sentence_window,
                                "pdf_parse_lane_policy": pdf_config.parse_lane_policy,
                            }
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
                    current_batch_index = 0
                    current_batch_points = 0
                    current_batch_bytes = 0
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


def find_structured_candidates(message: str, corpora: list[str]) -> list[dict[str, Any]]:
    lowered = message.lower()
    search_terms = [term for term in re.findall(r"[A-Za-z0-9_.-]+", lowered) if len(term) > 1]
    if not search_terms:
        return []
    with SessionLocal() as session:
        documents = select_documents_for_corpus(session, corpora[0]) if len(corpora) == 1 else list(
            session.scalars(select(DocumentRecord).where(DocumentRecord.corpus.in_(corpora or [settings.app_default_corpus])))
        )
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


def build_query_plan(message: str, corpora: list[str], top_k: int, trace_id: str) -> dict[str, Any]:
    with SessionLocal() as session:
        connection = get_active_connection(session, "openai")
        kb_config = dict(get_default_runtime_profile(session).kb_config_json or {})
        embedding_model_id = kb_config.get("embedding_model_id")
        mode = classify_query_mode(message)
        citations: list[dict[str, Any]] = []
        direct_answer: str | None = None
        structured_candidates = find_structured_candidates(message, corpora) if mode in {"structured", "blended"} else []
        structured_context: list[str] = []
        if structured_candidates:
            target_field = None
            top_row_json = structured_candidates[0]["row"].row_json
            for key in top_row_json:
                key_terms = [key.casefold(), key.replace("_", " ").casefold()]
                if any(re.search(rf"\b{re.escape(term)}\b", message.lower()) for term in key_terms):
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
            if target_field and target_field in top_row_json and mode == "structured" and len(message.split()) <= 20:
                value = top_row_json.get(target_field, "")
                top = structured_candidates[0]
                direct_answer = (
                    f"{target_field.replace('_', ' ').title()} is {value} "
                    f"(sheet {top['sheet'].name}, table {top['table'].name}, row {top['row'].row_index})."
                )

        semantic_context: list[str] = []
        if mode in {"semantic", "blended"} or not direct_answer:
            query_vectors = embed_texts(
                [message],
                connection,
                embedding_model=embedding_model_id,
                trace_id=trace_id,
                service="workflow-runtime",
            )
            if query_vectors:
                for hit in search_vectors(query_vectors[0], corpora, top_k, trace_id=trace_id, service="workflow-runtime"):
                    metadata = hit.get("metadata", {})
                    semantic_context.append(hit["text"])
                    citations.append(
                        {
                            "document_id": hit["document_id"],
                            "filename": hit["filename"],
                            "corpus": hit["corpus"],
                            "artifact_type": hit.get("artifact_type", "chunk"),
                            "source_path": hit["source_path"],
                            "chunk_index": hit.get("chunk_index"),
                            "page_start": metadata.get("page_start"),
                            "page_end": metadata.get("page_end"),
                            "section_title": hit.get("section_title", metadata.get("section_title")),
                            "section_path": hit.get("section_path", metadata.get("section_path")),
                            "heading_level": hit.get("heading_level", metadata.get("heading_level")),
                            "parse_lane": hit.get("parse_lane", metadata.get("parse_lane")),
                            "sheet_name": metadata.get("sheet_name"),
                            "table_name": metadata.get("table_name"),
                            "row_index": metadata.get("row_index"),
                        }
                    )

        if direct_answer:
            return {"query_mode": mode, "direct_answer": direct_answer, "prompt": None, "citations": citations}

        all_context = []
        if structured_context:
            all_context.append("Structured lookup candidates:\n" + "\n".join(structured_context))
        if semantic_context:
            all_context.append("Semantic retrieval candidates:\n" + "\n".join(semantic_context))
        if not all_context:
            prompt = (
                f"User question: {message}\n\n"
                "No matching structured rows or semantic retrieval artifacts were found. "
                "Say clearly that no grounded answer is available."
            )
        else:
            prompt = (
                "Use only the grounded context below. If the question asks for an exact row value, prefer the "
                "structured lookup evidence first.\n\n"
                + "\n\n".join(all_context)
                + f"\n\nUser question: {message}"
            )
        if mode == "structured" and structured_context and semantic_context:
            mode = "blended"
        return {"query_mode": mode, "direct_answer": None, "prompt": prompt, "citations": citations}


class QueryWorkflow(Workflow):
    @step
    async def prepare_query(self, ev: StartEvent) -> StopEvent:
        result = build_query_plan(
            message=str(start_event_value(ev, "message")),
            corpora=list(start_event_value(ev, "corpora") or []),
            top_k=int(start_event_value(ev, "top_k") or 6),
            trace_id=str(start_event_value(ev, "trace_id")),
        )
        return StopEvent(result=result)
