"""Voice Operator Console API tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from ghostdash_api.control_api import create_app


def test_operator_health_and_workflow_map():
    client = TestClient(create_app())
    health = client.get("/api/elevenlabs/operator/health")
    assert health.status_code == 200
    body = health.json()
    assert body["service"] == "elevenlabs-operator"
    assert "capabilities" in body

    workflow = client.get("/api/elevenlabs/operator/workflow-map")
    assert workflow.status_code == 200
    assert "two_tool" in workflow.json()
