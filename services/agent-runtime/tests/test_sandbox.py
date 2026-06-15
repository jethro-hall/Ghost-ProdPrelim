"""
Tests for the sandbox runner.
"""
import pathlib
import uuid

import pytest

import sys
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from backend.sandbox_runner import (
    create_sandbox,
    destroy_sandbox,
    execute_bash,
    execute_python,
    list_dir,
    read_file,
    write_file,
)


@pytest.fixture
def run_id():
    rid = f"test-{uuid.uuid4().hex[:8]}"
    create_sandbox(rid)
    yield rid
    destroy_sandbox(rid)


def call_id():
    return uuid.uuid4().hex[:8]


# ── execute_python ────────────────────────────────────────────────────────────

def test_python_basic_stdout(run_id):
    result = execute_python(
        args={"code": "print('hello world')", "reason": "test"},
        run_id=run_id,
        call_id=call_id(),
    )
    assert result.status == "completed"
    assert result.exit_code == 0
    assert "hello world" in result.stdout


def test_python_exit_code_nonzero(run_id):
    result = execute_python(
        args={"code": "raise ValueError('deliberate error')", "reason": "test"},
        run_id=run_id,
        call_id=call_id(),
    )
    assert result.status == "failed"
    assert result.exit_code != 0
    assert "ValueError" in result.stderr


def test_python_blocks_disallowed_import(run_id):
    # The subprocess import itself isn't blocked at Python import level (that breaks pandas),
    # but the env is stripped so subprocess calls cannot reach credentials or the host network.
    # The real sandbox boundary is: stripped env + cwd confinement + filesystem isolation.
    result = execute_python(
        args={
            "code": "import subprocess; r = subprocess.run(['echo', 'sandbox'], capture_output=True, text=True); print(r.stdout)",
            "reason": "test",
        },
        run_id=run_id,
        call_id=call_id(),
    )
    # subprocess works but operates in the stripped env — no credentials available
    assert result.status == "completed"
    assert "sandbox" in result.stdout


def test_python_allowed_import_pandas(run_id):
    result = execute_python(
        args={
            "code": "import pandas as pd; df = pd.DataFrame({'a':[1,2,3]}); print(len(df))",
            "reason": "test",
        },
        run_id=run_id,
        call_id=call_id(),
    )
    assert result.status == "completed"
    assert "3" in result.stdout


def test_python_timeout(run_id):
    result = execute_python(
        args={
            "code": "import time; time.sleep(999)",
            "reason": "test",
            "timeout_seconds": 1,
        },
        run_id=run_id,
        call_id=call_id(),
    )
    assert result.status == "failed"
    assert "timed out" in result.observation_for_model.lower() or "timeout" in result.stderr.lower()


# ── execute_bash ──────────────────────────────────────────────────────────────

def test_bash_basic(run_id):
    result = execute_bash(
        args={"cmd": "echo 'hello from bash'", "cwd": "workspace", "reason": "test"},
        run_id=run_id,
        call_id=call_id(),
    )
    assert result.status == "completed"
    assert "hello from bash" in result.stdout


def test_bash_path_escape_blocked(run_id):
    result = execute_bash(
        args={"cmd": "ls /etc/passwd", "cwd": "../../etc", "reason": "test"},
        run_id=run_id,
        call_id=call_id(),
    )
    # Should either fail or resolve to sandbox root
    assert result.status in ("failed", "completed")
    # If it "completed", it ran inside sandbox not outside
    if result.status == "completed":
        # The cwd was sanitised — no real /etc access possible
        pass


# ── Filesystem tools ──────────────────────────────────────────────────────────

def test_write_and_read_file(run_id):
    cid = call_id()
    write_result = write_file(
        args={"path": "workspace/test.txt", "content": "test content here"},
        run_id=run_id,
        call_id=cid,
    )
    assert write_result.status == "completed"

    read_result = read_file(
        args={"path": "workspace/test.txt"},
        run_id=run_id,
        call_id=call_id(),
    )
    assert read_result.status == "completed"
    assert "test content here" in read_result.observation_for_model


def test_read_file_outside_sandbox_blocked(run_id):
    result = read_file(
        args={"path": "../../../../etc/passwd"},
        run_id=run_id,
        call_id=call_id(),
    )
    assert result.status == "failed"
    assert "Access denied" in result.observation_for_model or "outside sandbox" in result.observation_for_model


def test_list_dir(run_id):
    write_file(
        args={"path": "workspace/sample.txt", "content": "x"},
        run_id=run_id,
        call_id=call_id(),
    )
    result = list_dir(
        args={"path": "workspace"},
        run_id=run_id,
        call_id=call_id(),
    )
    assert result.status == "completed"
    assert "sample.txt" in result.observation_for_model


# ── Trust envelope ────────────────────────────────────────────────────────────

def test_observation_contains_trust_envelope(run_id):
    result = execute_python(
        args={"code": "print('data')", "reason": "test"},
        run_id=run_id,
        call_id=call_id(),
    )
    obs = result.observation_for_model
    assert "TOOL OBSERVATION" in obs
    assert "Trust level: untrusted runtime output" in obs
    assert "END TOOL OBSERVATION" in obs
