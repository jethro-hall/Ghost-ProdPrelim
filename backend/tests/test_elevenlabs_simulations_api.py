from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from ghostdash_api import control_api


def _write_simulation(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "conversation": {
                    "id": "conv_test_1",
                    "user": "Jeff Hall",
                    "brief_summary": "Scooter booking request",
                    "title": "Booking",
                    "duration_seconds": 120,
                },
                "full_transcript_playback": [
                    {"role": "agent", "at_seconds": 0, "text": "Hello, how can I help?"},
                    {"role": "user", "at_seconds": 5, "text": "I need to book my scooter in."},
                    {"role": "agent", "at_seconds": 11, "text": "Which store do you prefer?"},
                ],
            }
        ),
        encoding="utf-8",
    )


def test_simulations_list_endpoint_reads_generated_files(monkeypatch, tmp_path: Path) -> None:
    sim_file = tmp_path / "JSON_Jeff_Hall&Scooter_booking_SIMULATION.json"
    _write_simulation(sim_file)

    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_simulations._simulations_dir", lambda: tmp_path)

    app = control_api.create_app()
    client = TestClient(app)
    response = client.get("/api/elevenlabs/analysis/simulations", params={"limit": 10})
    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is True
    assert body["count"] == 1
    assert body["items"][0]["conversation_id"] == "conv_test_1"
    assert body["items"][0]["user"] == "Jeff Hall"


def test_simulation_detail_returns_strict_elevenlabs_payload(monkeypatch, tmp_path: Path) -> None:
    sim_file = tmp_path / "JSON_Jeff_Hall&Scooter_booking_SIMULATION.json"
    _write_simulation(sim_file)

    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_simulations._simulations_dir", lambda: tmp_path)

    app = control_api.create_app()
    client = TestClient(app)
    response = client.get(f"/api/elevenlabs/analysis/simulations/{sim_file.name}")
    assert response.status_code == 200
    body = response.json()
    strict = body["elevenlabs_test_payload"]
    assert strict["type"] == "llm"
    assert strict["from_conversation_metadata"]["conversation_id"] == "conv_test_1"
    assert isinstance(strict["chat_history"], list)
    assert strict["chat_history"][0]["role"] == "agent"
    assert "tool_call_parameters" in strict
