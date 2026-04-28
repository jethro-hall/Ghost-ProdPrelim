from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

import ghostdash_api.collections as collection_store
from ghostdash_api.database import Base
from ghostdash_api.models import (
    AgentConversationRecord,
    AgentMessageRecord,
    AgentProfileRecord,
    ChatResponseCacheRecord,
    DocumentRecord,
    DocumentVersionRecord,
    IngestionRunRecord,
    RetrievalArtifactRecord,
    WorkbookArtifactRecord,
    WorkbookRowRecord,
    WorkbookSheetRecord,
    WorkbookTableRecord,
)
from ghostdash_api.runtime_profiles import seed_default_runtime_profile


def build_session():
    engine = create_engine("sqlite:///:memory:", future=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)
    return SessionLocal


def test_delete_collection_and_storage_removes_all_known_storage_points(tmp_path, monkeypatch) -> None:
    SessionLocal = build_session()
    deleted_document_ids: list[str] = []
    deleted_corpora: list[str] = []

    monkeypatch.setattr(collection_store, "count_corpus_vectors", lambda slug: 7 if slug == "finance" else 0)
    monkeypatch.setattr(collection_store, "delete_document_vectors", lambda document_id: deleted_document_ids.append(document_id))
    monkeypatch.setattr(collection_store, "delete_corpus_vectors", lambda slug: deleted_corpora.append(slug))
    monkeypatch.setattr(collection_store.settings, "app_upload_dir", str(tmp_path / "uploads"))

    upload_dir = collection_store.settings.upload_dir / "finance"
    upload_dir.mkdir(parents=True, exist_ok=True)
    source_path = upload_dir / "budget.txt"
    source_path.write_text("finance data", encoding="utf-8")
    version_path = upload_dir / "budget-v1.txt"
    version_path.write_text("finance data", encoding="utf-8")

    with SessionLocal() as session:
        default_profile = seed_default_runtime_profile(session)
        finance = collection_store.ensure_collection_record(session, slug="finance", name="Finance")
        collection_store.sync_runtime_profile_collection_bindings(session, default_profile, ["finance"], create_missing=False)

        agent = AgentProfileRecord(
            name="Finance Agent",
            first_message="hello",
            language="en-US",
            voice_id="alloy",
            runtime_profile_id=default_profile.id,
            is_default=False,
            enabled=True,
        )
        session.add(agent)
        session.flush()

        document = DocumentRecord(
            corpus="finance",
            filename="budget.txt",
            source_path=str(source_path),
            requested_lane="local",
            parse_status="completed",
            index_status="completed",
            status="indexed",
        )
        session.add(document)
        session.flush()

        session.add(
            DocumentVersionRecord(
                document_id=document.id,
                version_hash="hash-1",
                storage_path=str(version_path),
                size_bytes=12,
                mime_type="text/plain",
                source_kind="document",
            )
        )
        session.add(RetrievalArtifactRecord(document_id=document.id, corpus="finance", artifact_type="chunk", text="artifact"))
        session.add(IngestionRunRecord(run_type="full_sync", corpus="finance", status="completed", current_step="finalize"))
        session.flush()

        workbook = WorkbookArtifactRecord(
            document_id=document.id,
            document_version_id="version-1",
            filename=document.filename,
            sheet_count=1,
        )
        session.add(workbook)
        session.flush()
        sheet = WorkbookSheetRecord(workbook_artifact_id=workbook.id, name="Sheet1", ordinal=1, row_count=1)
        session.add(sheet)
        session.flush()
        table = WorkbookTableRecord(workbook_sheet_id=sheet.id, name="Table1", ordinal=1, header_json=["amount"], row_count=1)
        session.add(table)
        session.flush()
        session.add(WorkbookRowRecord(document_id=document.id, workbook_table_id=table.id, row_index=1, row_json={"amount": 10}, search_text="amount 10"))

        conversation = AgentConversationRecord(agent_id=agent.id, title="Finance", corpora_json=["finance"], api_mode="responses")
        session.add(conversation)
        session.flush()
        session.add(
            AgentMessageRecord(
                conversation_id=conversation.id,
                agent_id=agent.id,
                role="assistant",
                content="Finance answer",
                citations_json=[{"corpus": "finance", "document_id": document.id, "filename": document.filename, "artifact_type": "chunk", "source_path": str(source_path)}],
                api_mode="responses",
            )
        )
        session.add(
            ChatResponseCacheRecord(
                agent_id=agent.id,
                request_hash="cache-1",
                answer_text="cached answer",
                query_mode="semantic",
                citations_json=[{"corpus": "finance", "document_id": document.id, "filename": document.filename, "artifact_type": "chunk", "source_path": str(source_path)}],
            )
        )
        session.commit()

        impact = collection_store.collection_delete_impact(session, finance)
        assert impact["documents"] == 1
        assert impact["vector_points"] == 7
        assert impact["agents"] == 1
        assert impact["conversations"] == 1

        deleted = collection_store.delete_collection_and_storage(session, finance)
        assert deleted["documents"] == 1

        assert session.scalar(select(DocumentRecord).where(DocumentRecord.corpus == "finance")) is None
        assert session.scalar(select(DocumentVersionRecord)) is None
        assert session.scalar(select(RetrievalArtifactRecord)) is None
        assert session.scalar(select(WorkbookArtifactRecord)) is None
        assert session.scalar(select(WorkbookSheetRecord)) is None
        assert session.scalar(select(WorkbookTableRecord)) is None
        assert session.scalar(select(WorkbookRowRecord)) is None
        assert session.scalar(select(IngestionRunRecord).where(IngestionRunRecord.corpus == "finance")) is None
        assert session.scalar(select(AgentConversationRecord)) is None
        assert session.scalar(select(AgentMessageRecord)) is None
        assert session.scalar(select(ChatResponseCacheRecord)) is None
        assert collection_store.get_collection_by_slug(session, "finance") is None

    assert source_path.exists() is False
    assert version_path.exists() is False
    assert upload_dir.exists() is False
    assert deleted_document_ids
    assert deleted_corpora == ["finance"]


def test_backfill_collection_registry_normalizes_legacy_default_embedding_metadata(monkeypatch) -> None:
    SessionLocal = build_session()
    monkeypatch.setattr(
        collection_store.settings,
        "app_default_embedding_model",
        "openai/intfloat/multilingual-e5-large-instruct",
    )

    with SessionLocal() as session:
        default_profile = seed_default_runtime_profile(session)
        default_profile.kb_config_json = {
            **dict(default_profile.kb_config_json or {}),
            "embedding_model_id": "text-embedding-3-small",
            "default_corpora": ["finance"],
        }
        finance = collection_store.ensure_collection_record(
            session,
            slug="finance",
            name="Finance",
            embedding_model_id="text-embedding-3-small",
        )
        default_collection = collection_store.ensure_collection_record(
            session,
            slug="default",
            name="Default",
            embedding_model_id="text-embedding-3-small",
        )
        session.commit()

        collection_store.backfill_collection_registry(session)

        session.refresh(default_profile)
        session.refresh(finance)
        session.refresh(default_collection)

    assert default_profile.kb_config_json["embedding_model_id"] == "openai/intfloat/multilingual-e5-large-instruct"
    assert finance.embedding_model_id == "openai/intfloat/multilingual-e5-large-instruct"
    assert default_collection.embedding_model_id == "openai/intfloat/multilingual-e5-large-instruct"
