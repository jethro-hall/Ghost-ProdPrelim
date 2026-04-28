from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from ghostdash_api import control_api
from ghostdash_api.collections import ensure_collection_record
from ghostdash_api.database import Base, get_session
from ghostdash_api.models import AgentConversationRecord, AgentProfileRecord, ChatUploadRecord, DocumentRecord


def build_client(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)

    monkeypatch.setattr(control_api, "initialize_control_runtime_state", lambda: None)
    monkeypatch.setattr(control_api.settings, "app_upload_dir", str(tmp_path / "uploads"))

    def override_get_session():
        with SessionLocal() as session:
            yield session

    app = control_api.create_app()
    app.dependency_overrides[get_session] = override_get_session
    return TestClient(app), SessionLocal


def seed_agent_conversation(SessionLocal):
    with SessionLocal() as session:
        collection = ensure_collection_record(session, slug="finance", name="Finance")
        agent = AgentProfileRecord(
            name="Upload Agent",
            first_message="hello",
            language="en-US",
            voice_id="alloy",
            runtime_profile_id=None,
            is_default=True,
            enabled=True,
        )
        session.add(agent)
        session.flush()
        conversation = AgentConversationRecord(
            agent_id=agent.id,
            title="Upload Conversation",
            corpora_json=["finance"],
            api_mode="responses",
        )
        session.add(conversation)
        session.commit()
        return agent.id, conversation.id, collection.id


def test_chat_upload_can_stay_conversation_only(tmp_path, monkeypatch) -> None:
    client, SessionLocal = build_client(tmp_path, monkeypatch)
    agent_id, conversation_id, _ = seed_agent_conversation(SessionLocal)

    stage_response = client.post(
        f"/api/conversations/{conversation_id}/uploads",
        data={"agent_id": agent_id, "policy_lane": "default"},
        files={"file": ("brief.txt", b"Quarterly planning memo for chat-only use.", "text/plain")},
    )
    assert stage_response.status_code == 200
    upload_id = stage_response.json()["id"]

    decide_response = client.post(
        f"/api/chat/uploads/{upload_id}/decision",
        json={"persistence_mode": "conversation_only"},
    )
    assert decide_response.status_code == 200
    assert decide_response.json()["status"] == "conversation_only"
    assert decide_response.json()["promoted_document_id"] is None

    with SessionLocal() as session:
        upload = session.get(ChatUploadRecord, upload_id)
        document_count = int(session.scalar(select(func.count(DocumentRecord.id))) or 0)

    assert upload is not None
    assert upload.persistence_mode == "conversation_only"
    assert document_count == 0


def test_chat_upload_requires_collection_before_document_promotion(tmp_path, monkeypatch) -> None:
    client, SessionLocal = build_client(tmp_path, monkeypatch)
    agent_id, conversation_id, collection_id = seed_agent_conversation(SessionLocal)

    stage_response = client.post(
        f"/api/conversations/{conversation_id}/uploads",
        data={"agent_id": agent_id, "policy_lane": "default"},
        files={"file": ("brief.txt", b"Persistent knowledge content for later retrieval.", "text/plain")},
    )
    assert stage_response.status_code == 200
    upload_id = stage_response.json()["id"]

    waiting_response = client.post(
        f"/api/chat/uploads/{upload_id}/decision",
        json={"persistence_mode": "save_to_knowledge"},
    )
    assert waiting_response.status_code == 200
    assert waiting_response.json()["status"] == "awaiting_collection"
    assert waiting_response.json()["promoted_document_id"] is None

    promote_response = client.post(
        f"/api/chat/uploads/{upload_id}/decision",
        json={"persistence_mode": "save_to_knowledge", "collection_id": collection_id},
    )
    assert promote_response.status_code == 200
    promoted_upload = promote_response.json()
    assert promoted_upload["status"] == "approved_for_indexing"
    assert promoted_upload["collection_id"] == collection_id
    assert promoted_upload["collection_slug"] == "finance"
    assert promoted_upload["promoted_document_id"]

    with SessionLocal() as session:
        upload = session.get(ChatUploadRecord, upload_id)
        document = session.get(DocumentRecord, promoted_upload["promoted_document_id"])

    assert upload is not None
    assert document is not None
    assert upload.promoted_document_id == document.id
    assert document.corpus == "finance"
    assert document.metadata_json["chat_upload_id"] == upload.id
    assert Path(document.source_path).is_file()
