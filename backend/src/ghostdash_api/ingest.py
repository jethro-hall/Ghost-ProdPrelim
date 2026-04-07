"""Extract text from uploads: local lane (on-box) and cloud lane (LlamaParse)."""

from __future__ import annotations

import io
from pathlib import Path

from bs4 import BeautifulSoup
from openpyxl import load_workbook
from pptx import Presentation
from pypdf import PdfReader

from .settings import get_settings

settings = get_settings()


def extract_text_local(path: Path) -> tuple[str, str]:
    """Return (text, parse_lane_label)."""
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".json"}:
        return path.read_text(encoding="utf-8", errors="replace"), "local_text"

    if suffix == ".pdf":
        reader = PdfReader(str(path))
        parts: list[str] = []
        for page in reader.pages:
            t = page.extract_text() or ""
            if t.strip():
                parts.append(t)
        return "\n\n".join(parts), "local_pypdf"

    if suffix == ".docx":
        from docx import Document as DocxDocument

        doc = DocxDocument(str(path))
        return "\n".join(p.text for p in doc.paragraphs if p.text.strip()), "local_docx"

    if suffix == ".pptx":
        prs = Presentation(str(path))
        lines: list[str] = []
        for slide in prs.slides:
            for shape in slide.shapes:
                if hasattr(shape, "text") and shape.text:
                    lines.append(shape.text)
        return "\n".join(lines), "local_pptx"

    if suffix in {".xlsx", ".xlsm"}:
        wb = load_workbook(str(path), read_only=True, data_only=True)
        lines: list[str] = []
        for sheet in wb.worksheets:
            lines.append(f"## Sheet: {sheet.title}")
            for row in sheet.iter_rows(values_only=True):
                cells = [str(c) if c is not None else "" for c in row]
                if any(x.strip() for x in cells):
                    lines.append("\t".join(cells))
        wb.close()
        return "\n".join(lines), "local_xlsx"

    if suffix in {".html", ".htm"}:
        soup = BeautifulSoup(path.read_text(encoding="utf-8", errors="replace"), "html.parser")
        return soup.get_text(separator="\n"), "local_html"

    return path.read_text(encoding="utf-8", errors="replace"), "local_fallback"


def extract_text_cloud(path: Path, tier: str) -> tuple[str, str]:
    """Parse via LlamaParse (requires LLAMA_CLOUD_API_KEY)."""
    key = settings.llama_cloud_api_key
    if not key:
        raise ValueError("LLAMA_CLOUD_API_KEY is not set; cannot use cloud parse lane")

    from llama_parse import LlamaParse

    _ = tier  # reserved for SDK flags; tier name varies by llama-parse version
    parser = LlamaParse(
        api_key=key,
        result_type="markdown",
    )
    documents = parser.load_data(str(path))
    text = "\n\n".join(getattr(d, "text", "") or "" for d in documents)
    return text, "llamaparse"
