"""Extract text from uploads using local parsers or LlamaParse."""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import tiktoken
from bs4 import BeautifulSoup
from llama_index.core import Document
from llama_index.core.ingestion import IngestionPipeline
from llama_index.core.node_parser import SentenceWindowNodeParser
from openpyxl import load_workbook
from pptx import Presentation
from pypdf import PdfReader

from .settings import get_settings
from .telemetry import wrap_outbound_call

settings = get_settings()
TOKEN_ENCODER = tiktoken.get_encoding("cl100k_base")
PDF_ARTIFACT_TYPE = "pdf_sentence_window"
PDF_WINDOW_METADATA_KEY = "window_text"
PDF_ORIGINAL_TEXT_METADATA_KEY = "original_text"


@dataclass(slots=True)
class PdfPage:
    page_number: int
    text: str


@dataclass(slots=True)
class PdfExtractionResult:
    documents: list[Document]
    parse_lane: str
    page_count: int
    total_text_chars: int


def extract_spreadsheet_structure(path: Path) -> dict[str, Any] | None:
    suffix = path.suffix.lower()
    if suffix not in {".xlsx", ".xlsm"}:
        return None

    wb = load_workbook(str(path), read_only=True, data_only=True)
    sheets: list[dict[str, Any]] = []
    try:
        for sheet in wb.worksheets:
            rows: list[list[str]] = []
            for row in sheet.iter_rows(values_only=True):
                cells = [str(cell) if cell is not None else "" for cell in row]
                if any(cell.strip() for cell in cells):
                    rows.append(cells)
            sheets.append({"title": sheet.title, "rows": rows})
    finally:
        wb.close()

    return {
        "kind": "workbook",
        "sheet_count": len(sheets),
        "sheets": sheets,
    }


def normalize_text_content(text: str) -> str:
    text = unicodedata.normalize("NFKC", text.replace("\x00", ""))
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def estimate_token_count(text: str) -> int:
    if not text.strip():
        return 0
    return len(TOKEN_ENCODER.encode(text))


def detect_section_title(text: str) -> str | None:
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            return line.lstrip("# ").strip()[:200]
        if len(line) <= 100 and line.upper() == line and any(char.isalpha() for char in line):
            return line.title()[:200]
    return None


def _first_nonempty_line(text: str) -> str | None:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return None


def _last_nonempty_line(text: str) -> str | None:
    for line in reversed(text.splitlines()):
        stripped = line.strip()
        if stripped:
            return stripped
    return None


def _strip_repeated_pdf_artifacts(pages: list[PdfPage]) -> list[PdfPage]:
    if len(pages) < 3:
        return pages

    threshold = max(3, int(len(pages) * 0.6))
    headers = Counter(
        line.casefold()
        for page in pages
        if (line := _first_nonempty_line(page.text)) and len(line) <= 160 and any(char.isalpha() for char in line)
    )
    footers = Counter(
        line.casefold()
        for page in pages
        if (line := _last_nonempty_line(page.text)) and len(line) <= 160 and any(char.isalpha() for char in line)
    )
    repeated_headers = {line for line, count in headers.items() if count >= threshold}
    repeated_footers = {line for line, count in footers.items() if count >= threshold}
    if not repeated_headers and not repeated_footers:
        return pages

    cleaned: list[PdfPage] = []
    for page in pages:
        lines = page.text.splitlines()
        while lines and lines[0].strip().casefold() in repeated_headers:
            lines.pop(0)
        while lines and lines[-1].strip().casefold() in repeated_footers:
            lines.pop()
        cleaned.append(PdfPage(page_number=page.page_number, text=normalize_text_content("\n".join(lines))))
    return cleaned


def extract_pdf_pages_local(path: Path) -> list[PdfPage]:
    reader = PdfReader(str(path))
    if reader.is_encrypted:
        try:
            decrypt_result = reader.decrypt("")
        except Exception as exc:  # pragma: no cover - library-specific failure path
            raise ValueError(f"pdf decryption failed: {exc}") from exc
        if decrypt_result == 0:
            raise ValueError("pdf is encrypted and cannot be decrypted without a password")
    pages = [
        PdfPage(page_number=page_number, text=normalize_text_content(page.extract_text() or ""))
        for page_number, page in enumerate(reader.pages, start=1)
    ]
    return [page for page in _strip_repeated_pdf_artifacts(pages) if page.text]


def pdf_requires_cloud_fallback(pages: list[PdfPage]) -> bool:
    if not pages:
        return True
    total_chars = sum(len(page.text) for page in pages)
    substantive_pages = sum(1 for page in pages if len(page.text) >= 120)
    return total_chars < 160 or substantive_pages == 0


def build_pdf_documents(
    *,
    page_texts: list[PdfPage],
    base_metadata: dict[str, Any],
) -> list[Document]:
    documents: list[Document] = []
    for page in page_texts:
        documents.append(
            Document(
                text=page.text,
                metadata={
                    **base_metadata,
                    "page_start": page.page_number,
                    "page_end": page.page_number,
                    "section_title": detect_section_title(page.text),
                    "token_count": estimate_token_count(page.text),
                },
            )
        )
    return documents


def build_pdf_document_from_markdown(*, text: str, base_metadata: dict[str, Any]) -> list[Document]:
    cleaned = normalize_text_content(text)
    if not cleaned:
        return []
    return [
        Document(
            text=cleaned,
            metadata={
                **base_metadata,
                "page_start": 1,
                "page_end": None,
                "section_title": detect_section_title(cleaned),
                "token_count": estimate_token_count(cleaned),
            },
        )
    ]


def build_pdf_nodes(*, documents: list[Document], window_size: int) -> list[Any]:
    pipeline = IngestionPipeline(
        transformations=[
            SentenceWindowNodeParser.from_defaults(
                window_size=window_size,
                window_metadata_key=PDF_WINDOW_METADATA_KEY,
                original_text_metadata_key=PDF_ORIGINAL_TEXT_METADATA_KEY,
            )
        ]
    )
    return list(pipeline.run(documents=documents, show_progress=False))


def extract_pdf_documents(
    *,
    path: Path,
    requested_lane: str,
    tier: str,
    trace_id: str,
    base_metadata: dict[str, Any],
    parse_lane_policy: str,
) -> PdfExtractionResult:
    if requested_lane == "cloud":
        text, parse_lane = extract_text_cloud(path, tier, trace_id)
        documents = build_pdf_document_from_markdown(text=text, base_metadata=base_metadata)
        return PdfExtractionResult(
            documents=documents,
            parse_lane=parse_lane,
            page_count=1 if documents else 0,
            total_text_chars=sum(len(document.text) for document in documents),
        )

    try:
        pages = extract_pdf_pages_local(path)
    except Exception:
        if parse_lane_policy == "auto" and settings.llama_cloud_api_key:
            text, parse_lane = extract_text_cloud(path, tier, trace_id)
            documents = build_pdf_document_from_markdown(text=text, base_metadata=base_metadata)
            return PdfExtractionResult(
                documents=documents,
                parse_lane=parse_lane,
                page_count=1 if documents else 0,
                total_text_chars=sum(len(document.text) for document in documents),
            )
        raise
    should_fallback = parse_lane_policy == "auto" and settings.llama_cloud_api_key and pdf_requires_cloud_fallback(pages)
    if should_fallback:
        text, parse_lane = extract_text_cloud(path, tier, trace_id)
        documents = build_pdf_document_from_markdown(text=text, base_metadata=base_metadata)
        return PdfExtractionResult(
            documents=documents,
            parse_lane=parse_lane,
            page_count=max(len(pages), 1 if documents else 0),
            total_text_chars=sum(len(document.text) for document in documents),
        )

    documents = build_pdf_documents(page_texts=pages, base_metadata=base_metadata)
    return PdfExtractionResult(
        documents=documents,
        parse_lane="local_pypdf",
        page_count=len(pages),
        total_text_chars=sum(len(document.text) for document in documents),
    )


def extract_text_local(path: Path) -> tuple[str, str]:
    """Return (text, parse_lane_label) for on-box parsing."""
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".json"}:
        return normalize_text_content(path.read_text(encoding="utf-8", errors="replace")), "local_text"

    if suffix == ".pdf":
        return "\n\n".join(page.text for page in extract_pdf_pages_local(path)), "local_pypdf"

    if suffix == ".docx":
        from docx import Document as DocxDocument

        doc = DocxDocument(str(path))
        return normalize_text_content("\n".join(p.text for p in doc.paragraphs if p.text.strip())), "local_docx"

    if suffix == ".pptx":
        prs = Presentation(str(path))
        lines: list[str] = []
        for slide in prs.slides:
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text:
                    lines.append(shape.text)
        return normalize_text_content("\n".join(lines)), "local_pptx"

    if suffix in {".xlsx", ".xlsm"}:
        structure = extract_spreadsheet_structure(path) or {"sheets": []}
        lines: list[str] = []
        for sheet in structure["sheets"]:
            lines.append(f"## Sheet: {sheet['title']}")
            for row in sheet["rows"]:
                lines.append("\t".join(row))
        return normalize_text_content("\n".join(lines)), "local_xlsx"

    if suffix in {".html", ".htm"}:
        html = path.read_text(encoding="utf-8", errors="replace")
        return normalize_text_content(BeautifulSoup(html, "html.parser").get_text(separator="\n")), "local_html"

    return normalize_text_content(path.read_text(encoding="utf-8", errors="replace")), "local_fallback"


def extract_text_cloud(path: Path, tier: str, trace_id: str) -> tuple[str, str]:
    """Parse via LlamaParse (requires LLAMA_CLOUD_API_KEY)."""
    if not settings.llama_cloud_api_key:
        raise ValueError("LLAMA_CLOUD_API_KEY is not set; cannot use cloud parse lane")

    from llama_parse import LlamaParse

    def _run() -> tuple[str, str]:
        parser = LlamaParse(
            api_key=settings.llama_cloud_api_key,
            result_type="markdown",
            verbose=False,
        )
        _ = tier  # reserved for future SDK tier flags
        documents = parser.load_data(str(path))
        text = "\n\n".join(getattr(document, "text", "") or "" for document in documents)
        return normalize_text_content(text), "llamaparse"

    return wrap_outbound_call(
        trace_id=trace_id,
        service="ghostdash-worker",
        route="llamaparse.parse",
        fn=_run,
    )
