from __future__ import annotations

from sqlalchemy import select

from ghostdash_api.models import VoiceTurnRecord
from ghostdash_api.voice_ingress import VOICE_SAFE_RECOVERY_TEXT

from test_agent_ingress_voice_openai_compat import build_client, joined_content, parse_openai_sse, post_voice, seed_agent, voice_payload


def test_voice_stream_blocks_public_diagnostic_output(monkeypatch) -> None:
    from ghostdash_api import voice_ingress

    client, SessionLocal = build_client(monkeypatch)
    agent_id = seed_agent(SessionLocal)
    monkeypatch.setattr(
        voice_ingress,
        "stream_answer",
        lambda *args, **kwargs: iter(["agent.orchestrator failed with backend error and trace_id"]),
    )

    response = post_voice(client, voice_payload(agent_id, content="Say the unsafe diagnostic output."))
    events, done_count = parse_openai_sse(response.text)
    text = joined_content(events)

    assert response.status_code == 200
    assert done_count == 1
    assert text == VOICE_SAFE_RECOVERY_TEXT
    assert "agent.orchestrator" not in response.text
    assert "backend error" not in response.text
    assert "trace_id" not in response.text

    with SessionLocal() as session:
        turn = session.scalar(select(VoiceTurnRecord))

    assert turn is not None
    assert turn.status == "blocked"
    assert turn.response_json["answer"] == VOICE_SAFE_RECOVERY_TEXT
