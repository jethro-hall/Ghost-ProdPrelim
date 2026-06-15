"""
Tests for the verifier agent — JSON parsing, PASS/FAIL detection.
No Bedrock call made in unit tests (verifier call is mocked).
"""
import sys
import pathlib
import json
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from backend.verifier_agent import (
    _parse_verifier_json,
    build_review_package,
)


def test_parse_pass_response():
    raw = json.dumps({
        "status": "PASS",
        "confidence": 0.95,
        "defects": [],
        "required_remediation": [],
        "fit_for_purpose_summary": "All checks passed.",
    })
    result = _parse_verifier_json(raw)
    assert result["status"] == "PASS"
    assert result["confidence"] == 0.95
    assert result["defects"] == []


def test_parse_fail_response():
    raw = json.dumps({
        "status": "FAIL",
        "confidence": 0.4,
        "defects": ["Missing control total", "No verification step"],
        "required_remediation": ["Add debit/credit balance check"],
        "fit_for_purpose_summary": "Defects found.",
    })
    result = _parse_verifier_json(raw)
    assert result["status"] == "FAIL"
    assert len(result["defects"]) == 2


def test_parse_markdown_wrapped_json():
    raw = "```json\n" + json.dumps({
        "status": "PASS",
        "confidence": 0.9,
        "defects": [],
        "required_remediation": [],
        "fit_for_purpose_summary": "ok",
    }) + "\n```"
    result = _parse_verifier_json(raw)
    assert result["status"] == "PASS"


def test_parse_invalid_returns_fail():
    result = _parse_verifier_json("This is not JSON at all")
    assert result["status"] == "FAIL"
    assert result["confidence"] < 0.5


def test_build_review_package_excludes_raw_data():
    package = build_review_package(
        question="What is the group P&L?",
        public_plan="PLAN: inspect catalog, materialize data, execute python...",
        tool_call_names=["catalog_data_sources", "execute_python", "submit_for_review"],
        artifact_manifest=[
            {"name": "pnl.json", "size_bytes": 1024, "description": "P&L output"},
        ],
        proposed_answer="Revenue: $10.25M",
        verified_claims=["Total debits match credits"],
        uncertain_items=["FX adjustments not in scope"],
    )
    assert "What is the group P&L?" in package
    assert "catalog_data_sources" in package
    assert "pnl.json" in package
    # Must NOT contain raw data or credentials
    assert "debit" not in package or "Total debits" in package  # only in verified claims
    assert "password" not in package.lower()
    assert "secret" not in package.lower()
