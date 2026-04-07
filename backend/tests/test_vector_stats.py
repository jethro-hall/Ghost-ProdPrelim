from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ghostdash_api.control_api import _compute_vector_stats
from ghostdash_api.database import Base
from ghostdash_api.models import (
    DocumentRecord,
    RetrievalArtifactRecord,
    WorkbookArtifactRecord,
    WorkbookRowRecord,
    WorkbookSheetRecord,
    WorkbookTableRecord,
)


def build_session():
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    return SessionLocal


def test_compute_vector_stats_counts_authoritative_totals_across_corpora() -> None:
    SessionLocal = build_session()

    with SessionLocal() as session:
        pdf_default = DocumentRecord(
            corpus="default",
            filename="report.pdf",
            source_path="/tmp/report.pdf",
            requested_lane="local",
            parse_status="completed",
            index_status="completed",
            status="indexed",
        )
        workbook_default = DocumentRecord(
            corpus="default",
            filename="workbook.xlsx",
            source_path="/tmp/workbook.xlsx",
            requested_lane="local",
            parse_status="completed",
            index_status="completed",
            status="indexed",
        )
        markdown_default = DocumentRecord(
            corpus="default",
            filename="notes.md",
            source_path="/tmp/notes.md",
            requested_lane="local",
            parse_status="completed",
            index_status="completed",
            status="indexed",
        )
        finance_other = DocumentRecord(
            corpus="finance",
            filename="slides.pptx",
            source_path="/tmp/slides.pptx",
            requested_lane="local",
            parse_status="completed",
            index_status="completed",
            status="indexed",
        )
        session.add_all([pdf_default, workbook_default, markdown_default, finance_other])
        session.commit()

        session.add_all(
            [
                RetrievalArtifactRecord(document_id=pdf_default.id, corpus="default", artifact_type="chunk", text="pdf-1"),
                RetrievalArtifactRecord(document_id=pdf_default.id, corpus="default", artifact_type="chunk", text="pdf-2"),
                RetrievalArtifactRecord(document_id=workbook_default.id, corpus="default", artifact_type="row_summary", text="xlsx-1"),
                RetrievalArtifactRecord(document_id=markdown_default.id, corpus="default", artifact_type="chunk", text="md-1"),
                RetrievalArtifactRecord(document_id=finance_other.id, corpus="finance", artifact_type="chunk", text="pptx-1"),
                RetrievalArtifactRecord(document_id=finance_other.id, corpus="finance", artifact_type="chunk", text="pptx-2"),
                RetrievalArtifactRecord(document_id=finance_other.id, corpus="finance", artifact_type="chunk", text="pptx-3"),
            ]
        )
        session.commit()

        workbook = WorkbookArtifactRecord(
            document_id=workbook_default.id,
            document_version_id="version-1",
            filename=workbook_default.filename,
            sheet_count=1,
        )
        session.add(workbook)
        session.commit()

        sheet = WorkbookSheetRecord(workbook_artifact_id=workbook.id, name="Sheet1", ordinal=0, row_count=2)
        session.add(sheet)
        session.commit()

        table = WorkbookTableRecord(workbook_sheet_id=sheet.id, name="Table1", ordinal=0, header_json=["amount"], row_count=2)
        session.add(table)
        session.commit()

        session.add_all(
            [
                WorkbookRowRecord(document_id=workbook_default.id, workbook_table_id=table.id, row_index=1, row_json={"amount": 10}, search_text="amount 10"),
                WorkbookRowRecord(document_id=workbook_default.id, workbook_table_id=table.id, row_index=2, row_json={"amount": 20}, search_text="amount 20"),
            ]
        )
        session.commit()

        overall = _compute_vector_stats(session)
        default = _compute_vector_stats(session, "default")
        finance = _compute_vector_stats(session, "finance")

    assert overall.documents == 4
    assert overall.retrieval_artifacts == 7
    assert overall.workbook_rows == 2
    assert overall.pdf_documents == 1
    assert overall.xlsx_documents == 1
    assert overall.txt_documents == 1
    assert overall.other_documents == 1

    assert default.documents == 3
    assert default.retrieval_artifacts == 4
    assert default.workbook_rows == 2
    assert default.pdf_documents == 1
    assert default.xlsx_documents == 1
    assert default.txt_documents == 1
    assert default.other_documents == 0

    assert finance.documents == 1
    assert finance.retrieval_artifacts == 3
    assert finance.workbook_rows == 0
    assert finance.pdf_documents == 0
    assert finance.xlsx_documents == 0
    assert finance.txt_documents == 0
    assert finance.other_documents == 1
