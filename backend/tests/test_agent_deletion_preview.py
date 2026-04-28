from __future__ import annotations

from sqlalchemy import func, select

from ghostdash_api.models import (
    AgentConversationRecord,
    AgentMessageRecord,
    AgentProfileRecord,
    ChatResponseCacheRecord,
    ChatUploadRecord,
    DocxSessionRecord,
    DocumentFrameRecord,
    WorkflowRunRecord,
    WorkflowStepRunRecord,
)
from ghostdash_api.runtime_profiles import seed_default_runtime_profile

from test_connections_and_bootstrap import build_client


def _seed_agents_and_chat(SessionLocal):
    with SessionLocal() as session:
        runtime_profile = seed_default_runtime_profile(session)
        default_agent = AgentProfileRecord(
            name="Default Agent",
            first_message="hello",
            language="en-US",
            voice_id="alloy",
            runtime_profile_id=runtime_profile.id,
            is_default=True,
            enabled=True,
        )
        peer_agent = AgentProfileRecord(
            name="Peer Agent",
            first_message="hello",
            language="en-US",
            voice_id="alloy",
            runtime_profile_id=runtime_profile.id,
            is_default=False,
            enabled=True,
        )
        session.add_all([default_agent, peer_agent])
        session.flush()

        frame = DocumentFrameRecord(title="Test Frame")
        session.add(frame)
        session.flush()

        conversation = AgentConversationRecord(
            agent_id=peer_agent.id,
            title="c1",
            corpora_json=[],
            api_mode="responses",
            conversation_mode="quick",
            workflow_mode="standard",
            document_frame_id=frame.id,
        )
        session.add(conversation)
        session.flush()

        session.add_all(
            [
                AgentMessageRecord(
                    conversation_id=conversation.id,
                    agent_id=peer_agent.id,
                    role="user",
                    content="hello",
                ),
                ChatUploadRecord(
                    conversation_id=conversation.id,
                    agent_id=peer_agent.id,
                    filename="test.txt",
                    storage_path=f"/tmp/{conversation.id}.txt",
                    source_kind="document",
                    requested_lane="default",
                    status="uploaded_pending_decision",
                ),
                DocxSessionRecord(
                    conversation_id=conversation.id,
                    agent_id=peer_agent.id,
                    operation="preview",
                    status="draft",
                ),
                ChatResponseCacheRecord(
                    agent_id=peer_agent.id,
                    request_hash="abc123",
                    answer_text="cached",
                    query_mode="semantic",
                ),
            ]
        )
        session.commit()
        return default_agent.id, peer_agent.id, conversation.id


def test_agent_deletion_preview_counts_chat_dependencies(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    _default_agent_id, peer_agent_id, _conversation_id = _seed_agents_and_chat(SessionLocal)

    response = client.post(f"/api/agents/{peer_agent_id}/deletion-preview", json={"scope": "chats"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["scope"] == "chats"
    assert payload["can_execute"] is True
    assert payload["blocking_reasons"] == []
    assert payload["impact"]["conversations"] == 1
    assert payload["impact"]["messages"] == 1
    assert payload["impact"]["uploads"] == 1
    assert payload["impact"]["docx_sessions"] == 1
    assert payload["impact"]["cache_entries"] == 1
    assert payload["impact"]["document_frames_linked"] == 1
    assert payload["impact"]["orphanable_document_frames"] == 1
    assert payload["confirmation_token"]


def test_agent_deletion_preview_blocks_default_agent_delete_scope(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    default_agent_id, _peer_agent_id, _conversation_id = _seed_agents_and_chat(SessionLocal)

    response = client.post(f"/api/agents/{default_agent_id}/deletion-preview", json={"scope": "agent"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["can_execute"] is False
    assert "default_agent_protected" in payload["blocking_reasons"]


def test_agent_deletion_preview_blocks_when_workflow_refs_are_active(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    _default_agent_id, peer_agent_id, conversation_id = _seed_agents_and_chat(SessionLocal)

    with SessionLocal() as session:
        run = WorkflowRunRecord(
            workflow_id="wf_test",
            status="running",
            current_step="step1",
            prompt="test",
            requested_agent_ids_json=[peer_agent_id],
            parent_conversation_id=conversation_id,
        )
        session.add(run)
        session.flush()
        session.add(
            WorkflowStepRunRecord(
                run_id=run.id,
                sequence=1,
                node_id="n1",
                node_type="child_agent",
                status="pending",
                agent_id=peer_agent_id,
                conversation_id=conversation_id,
            )
        )
        session.commit()

    response = client.post(f"/api/agents/{peer_agent_id}/deletion-preview", json={"scope": "chats"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["can_execute"] is False
    assert "active_workflow_runs" in payload["blocking_reasons"]
    assert "active_workflow_steps" in payload["blocking_reasons"]
    assert payload["impact"]["active_workflow_runs"] == 1
    assert payload["impact"]["active_workflow_steps"] >= 1


def test_agent_deletion_preview_ignores_stale_pending_step_when_run_completed(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    _default_agent_id, peer_agent_id, conversation_id = _seed_agents_and_chat(SessionLocal)

    with SessionLocal() as session:
        run = WorkflowRunRecord(
            workflow_id="wf_done",
            status="completed",
            current_step="completed",
            prompt="test",
            requested_agent_ids_json=[peer_agent_id],
            parent_conversation_id=conversation_id,
        )
        session.add(run)
        session.flush()
        session.add(
            WorkflowStepRunRecord(
                run_id=run.id,
                sequence=1,
                node_id="n1",
                node_type="child_agent",
                status="pending",
                agent_id=peer_agent_id,
                conversation_id=conversation_id,
            )
        )
        session.commit()

    response = client.post(f"/api/agents/{peer_agent_id}/deletion-preview", json={"scope": "agent"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["can_execute"] is True
    assert "active_workflow_steps" not in payload["blocking_reasons"]
    assert payload["impact"]["active_workflow_steps"] == 0


def test_delete_agent_conversations_and_agent_round_trip(monkeypatch) -> None:
    client, SessionLocal = build_client(monkeypatch)
    _default_agent_id, peer_agent_id, _conversation_id = _seed_agents_and_chat(SessionLocal)

    preview_chats = client.post(f"/api/agents/{peer_agent_id}/deletion-preview", json={"scope": "chats"})
    assert preview_chats.status_code == 200
    token_chats = preview_chats.json()["confirmation_token"]

    delete_chats = client.request(
        "DELETE",
        f"/api/agents/{peer_agent_id}/conversations",
        params={"confirm": "true"},
        json={"confirmation_token": token_chats},
    )
    assert delete_chats.status_code == 200
    chats_payload = delete_chats.json()
    assert chats_payload["deleted"] is True
    assert chats_payload["deleted_conversations"] == 1
    assert chats_payload["deleted_messages"] == 1
    assert chats_payload["deleted_uploads"] == 1
    assert chats_payload["deleted_docx_sessions"] == 1
    assert chats_payload["deleted_cache_entries"] == 1
    assert chats_payload["deleted_document_frames"] == 1

    preview_agent = client.post(f"/api/agents/{peer_agent_id}/deletion-preview", json={"scope": "agent"})
    assert preview_agent.status_code == 200
    token_agent = preview_agent.json()["confirmation_token"]

    delete_agent = client.request(
        "DELETE",
        f"/api/agents/{peer_agent_id}",
        params={"confirm": "true"},
        json={"confirmation_token": token_agent},
    )
    assert delete_agent.status_code == 200
    agent_payload = delete_agent.json()
    assert agent_payload["deleted"] is True
    assert agent_payload["id"] == peer_agent_id

    with SessionLocal() as session:
        assert session.get(AgentProfileRecord, peer_agent_id) is None
        assert int(session.scalar(select(func.count()).select_from(AgentConversationRecord)) or 0) == 0
