"""
Tests for tool registry — banned names, schema validation, dispatch.
"""
import sys
import pathlib
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

# Register all tools before testing dispatch
from backend import sandbox_runner, data_connector
from backend.tool_registry import _register_all, _REGISTRY

if "execute_bash" not in _REGISTRY:
    _register_all(sandbox_runner=sandbox_runner, data_connector=data_connector)

from backend.tool_registry import (
    BANNED_TOOL_NAMES,
    ToolDefinition,
    _REGISTRY,
    execute,
    needs_approval,
    register,
)


def test_banned_tool_raises():
    for name in BANNED_TOOL_NAMES:
        with pytest.raises(ValueError, match="banned"):
            register(
                ToolDefinition(
                    name=name,
                    description="test",
                    json_schema={"type": "object", "properties": {}},
                    category="data",
                    risk="read",
                    requires_approval=False,
                )
            )


def test_unknown_tool_returns_failed():
    result = execute(
        tool_name="nonexistent_tool_xyz",
        args={},
        run_id="test-run",
        call_id="test-call",
    )
    assert result.status == "failed"
    assert "Unknown tool" in result.observation_for_model


def test_missing_required_arg_returns_failed():
    # execute_bash requires cmd, cwd, reason
    result = execute(
        tool_name="execute_bash",
        args={"cmd": "echo hi"},  # missing cwd and reason
        run_id="test-run",
        call_id="test-call",
    )
    assert result.status == "failed"
    assert "Missing required" in result.observation_for_model


def test_extra_arg_with_additional_properties_false():
    result = execute(
        tool_name="execute_bash",
        args={"cmd": "ls", "cwd": "workspace", "reason": "test", "EXTRA_FIELD": "bad"},
        run_id="test-run",
        call_id="test-call",
    )
    assert result.status == "failed"
    assert "Unexpected args" in result.observation_for_model


def test_execute_bash_destructive_needs_approval():
    assert needs_approval("execute_bash", {"cmd": "rm -rf /tmp/foo", "cwd": "workspace", "reason": "test"})


def test_execute_bash_safe_no_approval():
    assert not needs_approval("execute_bash", {"cmd": "ls", "cwd": "workspace", "reason": "test"})
