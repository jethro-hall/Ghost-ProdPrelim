from __future__ import annotations

import json
from pathlib import Path

from fastapi import HTTPException
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
                ],
                "repeatable_real_world_tests": [
                    {
                        "id": "conv_test_1-replay",
                        "name": "Real call replay simulation",
                        "objective": "Replay booking intent and verify concise response.",
                        "steps": [{"step": 1, "action": "Ask to book scooter", "expected": "Agent asks for store"}],
                        "assertions": ["No internal diagnostics spoken to caller"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def test_tests_list_and_detail_include_execution_metadata(monkeypatch, tmp_path: Path) -> None:
    sim_file = tmp_path / "JSON_Jeff_Hall&Scooter_booking_SIMULATION.json"
    _write_simulation(sim_file)
    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_simulations._simulations_dir", lambda: tmp_path)

    client = TestClient(control_api.create_app())
    list_response = client.get("/api/elevenlabs/tests/simulations", params={"limit": 10})
    assert list_response.status_code == 200
    assert list_response.json()["count"] == 1

    detail_response = client.get(f"/api/elevenlabs/tests/simulations/{sim_file.name}")
    assert detail_response.status_code == 200
    body = detail_response.json()
    assert body["execution"]["simulation"]["runnable"] is True
    assert body["execution"]["next_reply"]["runnable"] is True
    assert body["execution"]["step_debugger"]["runnable"] is True
    assert len(body["tests"]) == 1


def test_run_simulation_returns_normalized_result(monkeypatch, tmp_path: Path) -> None:
    sim_file = tmp_path / "JSON_Jeff_Hall&Scooter_booking_SIMULATION.json"
    _write_simulation(sim_file)
    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_simulations._simulations_dir", lambda: tmp_path)
    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_test_platform._run_artifacts_dir",
        lambda: tmp_path / "runs",
    )

    class FakeResponse:
        status_code = 200

        def json(self) -> dict:
            return {
                "simulated_conversation": [
                    {"role": "user", "message": "I need to book my scooter in."},
                    {"role": "agent", "message": "Which store would you like?"},
                ],
                "analysis": {
                    "call_successful": "success",
                    "transcript_summary": "Agent handled booking intent.",
                    "call_summary_title": "Booking intent",
                },
            }

    async def fake_fetch_json(method: str, path: str, *, body: dict | None = None) -> dict:
        if method == "GET" and path.endswith("/conv_test_1"):
            return {"agent_id": "agent_test_123"}
        assert method == "POST"
        assert "simulate-conversation" in path
        return FakeResponse().json()

    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_test_platform._fetch_json", fake_fetch_json)
    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_test_platform.get_settings",
        lambda: type(
            "S",
            (),
            {
                "elevenlabs_api_key": "test-key",
                "elevenlabs_convai_agent_id": None,
                "elevenlabs_test_timeout_ms": 120000,
                "elevenlabs_analysis_timeout_ms": 15000,
                "app_data_dir": str(tmp_path),
            },
        )(),
    )

    client = TestClient(control_api.create_app())
    response = client.post(
        f"/api/elevenlabs/tests/simulations/{sim_file.name}/run",
        json={"test_id": "conv_test_1-replay", "max_turns": 3},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "passed"
    assert body["agent_id"] == "agent_test_123"
    assert body["turn_count"] == 2
    assert body["trace_id"]


def test_run_simulation_maps_upstream_http_error(monkeypatch, tmp_path: Path) -> None:
    sim_file = tmp_path / "JSON_Jeff_Hall&Scooter_booking_SIMULATION.json"
    _write_simulation(sim_file)
    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_simulations._simulations_dir", lambda: tmp_path)

    async def fake_fetch_json(method: str, path: str, *, body: dict | None = None) -> dict:
        if method == "GET":
            return {"agent_id": "agent_test_123"}
        raise HTTPException(
            status_code=502,
            detail={"code": "elevenlabs_upstream_error", "message": "upstream failed"},
        )

    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_test_platform._fetch_json", fake_fetch_json)
    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_test_platform.get_settings",
        lambda: type(
            "S",
            (),
            {
                "elevenlabs_api_key": "test-key",
                "elevenlabs_convai_agent_id": "agent_test_123",
                "elevenlabs_test_timeout_ms": 120000,
                "elevenlabs_analysis_timeout_ms": 15000,
                "app_data_dir": str(tmp_path),
            },
        )(),
    )

    client = TestClient(control_api.create_app())
    response = client.post(f"/api/elevenlabs/tests/simulations/{sim_file.name}/run", json={})
    assert response.status_code == 502
    body = response.json()
    assert body["status"] == "error"
    assert body["error_code"] == "elevenlabs_upstream_error"


def test_step_simulation_merges_history(monkeypatch, tmp_path: Path) -> None:
    sim_file = tmp_path / "JSON_Jeff_Hall&Scooter_booking_SIMULATION.json"
    _write_simulation(sim_file)
    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_simulations._simulations_dir", lambda: tmp_path)
    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_test_platform._run_artifacts_dir",
        lambda: tmp_path / "runs",
    )

    async def fake_fetch_json(method: str, path: str, *, body: dict | None = None) -> dict:
        if method == "GET":
            return {"agent_id": "agent_test_123"}
        assert body is not None
        assert body["new_turns_limit"] == 1
        partial = body["simulation_specification"]["partial_conversation_history"]
        assert partial[-1]["role"] == "user"
        assert partial[-1]["message"] == "Edited user line"
        return {
            "simulated_conversation": [
                {"role": "agent", "message": "Hello", "tool_calls": [], "tool_results": []},
                {"role": "user", "message": "Edited user line", "tool_calls": [], "tool_results": []},
                {
                    "role": "agent",
                    "message": "Thanks, checking now.",
                    "tool_calls": [{"tool_name": "hubtiger_job_search", "params_as_json": "{}"}],
                    "tool_results": [],
                },
            ],
            "analysis": {"call_successful": "success"},
        }

    monkeypatch.setattr("ghostdash_api.integrations.elevenlabs_test_platform._fetch_json", fake_fetch_json)
    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_test_platform.get_settings",
        lambda: type(
            "S",
            (),
            {
                "elevenlabs_api_key": "test-key",
                "elevenlabs_convai_agent_id": "agent_test_123",
                "elevenlabs_test_timeout_ms": 120000,
                "elevenlabs_analysis_timeout_ms": 15000,
                "app_data_dir": str(tmp_path),
            },
        )(),
    )

    client = TestClient(control_api.create_app())
    response = client.post(
        f"/api/elevenlabs/tests/simulations/{sim_file.name}/step",
        json={
            "history": [
                {"role": "agent", "message": "Hello", "time_in_call_secs": 0},
                {"role": "user", "message": "Original", "time_in_call_secs": 3},
            ],
            "stop_index": 1,
            "forced_user_message": "Edited user line",
            "step_mode": "agent",
            "agent_prompt_override": "Stay concise and customer-safe.",
            "expected_tool_name": "hubtiger_job_search",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "passed"
    assert body["stop_index"] == 1
    assert len(body["merged_history"]) == 3
    assert body["tool_check"]["passed"] is True
    assert body["elevenlabs_request"]["simulation_specification"]["partial_conversation_history"][-1]["message"] == "Edited user line"


def test_workbench_options_and_tool_mock_modes(monkeypatch) -> None:
    monkeypatch.setattr(
        "ghostdash_api.integrations.elevenlabs_test_platform.get_settings",
        lambda: type("S", (), {"elevenlabs_api_key": "test-key"})(),
    )
    from ghostdash_api.integrations.elevenlabs_test_platform import _resolve_tool_mock_config

    assert _resolve_tool_mock_config(raw=None, mode="call_real_tools", selected_tool_ids=[]) is None
    assert _resolve_tool_mock_config(raw=None, mode="mock_selected", selected_tool_ids=["tool_abc"]) is None

    custom = _resolve_tool_mock_config(raw={"mocking_strategy": "all"}, mode="call_real_tools", selected_tool_ids=[])
    assert custom == {"mocking_strategy": "all"}

    client = TestClient(control_api.create_app())
    options = client.get("/api/elevenlabs/tests/options")
    assert options.status_code == 200
    assert options.json()["endpoint_template"] == "/v1/convai/agents/{agent_id}/simulate-conversation"
