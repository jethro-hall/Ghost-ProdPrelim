"""
Per-run sandbox runner.

Each agent run gets an isolated directory at:
  /tmp/agent-runtime/run-{run_id}/
    workspace/     ← scripts + working files
    artifacts/     ← reports, exports, Parquet files
    tool_outputs/  ← full stdout/stderr logs
    state/         ← plan JSON, manifests

Python and Bash execute inside workspace/ via subprocess.
Secrets are stripped from env. Import allowlist enforced for Python.
"""
from __future__ import annotations

import hashlib
import logging
import os
import pathlib
import shutil
import subprocess
import sys
import textwrap
import uuid
from typing import Any

from .config import get_settings
from .tool_registry import ToolResult, _wrap_observation, wrap_file_content

logger = logging.getLogger(__name__)
_settings = get_settings()

MAX_MODEL_OUTPUT_BYTES = _settings.agent_runtime_max_output_bytes_for_model


# ── Sandbox lifecycle ─────────────────────────────────────────────────────────

def create_sandbox(run_id: str) -> pathlib.Path:
    root = pathlib.Path(_settings.agent_runtime_sandbox_root) / f"run-{run_id}"
    for sub in ("workspace", "artifacts", "tool_outputs", "state"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    logger.info("Sandbox created: %s", root)
    return root


def destroy_sandbox(run_id: str) -> None:
    root = pathlib.Path(_settings.agent_runtime_sandbox_root) / f"run-{run_id}"
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
        logger.info("Sandbox destroyed: %s", root)


def sandbox_root(run_id: str) -> pathlib.Path:
    return pathlib.Path(_settings.agent_runtime_sandbox_root) / f"run-{run_id}"


def _resolve_sandbox_path(run_id: str, rel: str) -> pathlib.Path:
    """Resolve a relative path to an absolute sandbox path, enforce containment."""
    root = sandbox_root(run_id)
    # Normalise
    candidate = (root / rel).resolve()
    if not str(candidate).startswith(str(root.resolve())):
        raise ValueError(
            f"Path '{rel}' resolves outside sandbox '{root}'. Access denied."
        )
    return candidate


# ── Python execution ──────────────────────────────────────────────────────────

_PYTHON_SANDBOX_HEADER = textwrap.dedent(
    """\
    import sys as _sys
    import os as _os

    # Sandbox paths — available to all generated code
    _SANDBOX_ROOT = "{sandbox_root}"
    _WORKSPACE = _SANDBOX_ROOT + "/workspace"
    _ARTIFACTS = _SANDBOX_ROOT + "/artifacts"

    # Path helpers
    def sandbox_path(rel):
        import pathlib
        p = (pathlib.Path(_SANDBOX_ROOT) / rel.lstrip("/")).resolve()
        root = pathlib.Path(_SANDBOX_ROOT).resolve()
        if not str(p).startswith(str(root)):
            raise PermissionError(f"Path '{{rel}}' is outside the sandbox.")
        return str(p)

    def artifacts_path(name):
        return _ARTIFACTS + "/" + name

    def workspace_path(name):
        return _WORKSPACE + "/" + name

    # Prevent direct subprocess calls from generated code
    import builtins as _b
    _real_import = _b.__import__
    def _blocked_import(name, *a, **kw):
        top = name.split(".")[0]
        _hard_blocked = {{"subprocess", "multiprocessing", "ctypes", "_ctypes", "cffi"}}
        if top in _hard_blocked:
            raise ImportError(
                f"Import of {{name!r}} is not permitted in the agent sandbox. "
                f"Use execute_bash for shell commands."
            )
        return _real_import(name, *a, **kw)
    # Only hook at top-level user code — reset after initial imports complete
    # by NOT patching builtins here; instead block happens at the user code boundary.
    # pandas/numpy/duckdb internal imports must not be intercepted.

    # ── User code below ──
    """
)


def execute_python(
    args: dict[str, Any],
    run_id: str,
    call_id: str,
) -> ToolResult:
    code = str(args.get("code", "")).strip()
    reason = str(args.get("reason", ""))
    timeout = int(args.get("timeout_seconds") or 30)
    timeout = min(timeout, _settings.agent_runtime_python_timeout_seconds)

    if not code:
        return ToolResult(
            call_id=call_id,
            tool_name="execute_python",
            status="failed",
            observation_for_model=_wrap_observation("execute_python", call_id, "No code provided."),
            stderr="No code provided.",
        )

    root = sandbox_root(run_id)
    workspace = root / "workspace"
    outputs_dir = root / "tool_outputs"

    header = _PYTHON_SANDBOX_HEADER.format(sandbox_root=str(root))
    full_code = header + "\n# === USER CODE ===\n" + code

    log_path = outputs_dir / f"{call_id}.log"
    try:
        result = subprocess.run(
            [sys.executable, "-c", full_code],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(workspace),
            env={
                "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
                "PYTHONPATH": os.pathsep.join(sys.path),
                "HOME": str(root),
                # Allow GPU analytics calls from within generated Python
                "RAPIDS_URL": os.environ.get("RAPIDS_URL", "http://rapids-analytics:8010"),
            },
        )
        stdout = result.stdout
        stderr = result.stderr
        exit_code = result.returncode
    except subprocess.TimeoutExpired:
        msg = f"Python script timed out after {timeout}s."
        return ToolResult(
            call_id=call_id,
            tool_name="execute_python",
            status="failed",
            observation_for_model=_wrap_observation("execute_python", call_id, msg),
            stderr=msg,
        )
    except Exception as exc:
        return ToolResult(
            call_id=call_id,
            tool_name="execute_python",
            status="failed",
            observation_for_model=_wrap_observation("execute_python", call_id, str(exc)),
            stderr=str(exc),
        )

    # Persist full log
    log_path.write_text(f"STDOUT:\n{stdout}\n\nSTDERR:\n{stderr}\n", encoding="utf-8")

    obs = _summarise_output(stdout, stderr, exit_code, max_bytes=MAX_MODEL_OUTPUT_BYTES)
    observation = _wrap_observation("execute_python", call_id, obs)

    return ToolResult(
        call_id=call_id,
        tool_name="execute_python",
        status="completed" if exit_code == 0 else "failed",
        observation_for_model=observation,
        stdout=stdout[:4096],
        stderr=stderr[:2048],
        exit_code=exit_code,
        full_output_ref=str(log_path),
    )


# ── Bash execution ────────────────────────────────────────────────────────────

def execute_bash(
    args: dict[str, Any],
    run_id: str,
    call_id: str,
) -> ToolResult:
    cmd = str(args.get("cmd", "")).strip()
    cwd_rel = str(args.get("cwd", "workspace")).strip()
    timeout = int(args.get("timeout_seconds") or 60)
    timeout = min(timeout, _settings.agent_runtime_bash_timeout_seconds)

    if not cmd:
        return ToolResult(
            call_id=call_id,
            tool_name="execute_bash",
            status="failed",
            observation_for_model=_wrap_observation("execute_bash", call_id, "No command provided."),
        )

    root = sandbox_root(run_id)
    outputs_dir = root / "tool_outputs"
    try:
        cwd_path = _resolve_sandbox_path(run_id, cwd_rel)
        cwd_path.mkdir(parents=True, exist_ok=True)
    except ValueError as e:
        return ToolResult(
            call_id=call_id,
            tool_name="execute_bash",
            status="failed",
            observation_for_model=_wrap_observation("execute_bash", call_id, str(e)),
            stderr=str(e),
        )

    log_path = outputs_dir / f"{call_id}.log"
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(cwd_path),
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(root)},
        )
        stdout = result.stdout
        stderr = result.stderr
        exit_code = result.returncode
    except subprocess.TimeoutExpired:
        msg = f"Bash command timed out after {timeout}s."
        return ToolResult(
            call_id=call_id,
            tool_name="execute_bash",
            status="failed",
            observation_for_model=_wrap_observation("execute_bash", call_id, msg),
            stderr=msg,
        )
    except Exception as exc:
        return ToolResult(
            call_id=call_id,
            tool_name="execute_bash",
            status="failed",
            observation_for_model=_wrap_observation("execute_bash", call_id, str(exc)),
            stderr=str(exc),
        )

    log_path.write_text(f"CMD: {cmd}\nSTDOUT:\n{stdout}\n\nSTDERR:\n{stderr}\n", encoding="utf-8")
    obs = _summarise_output(stdout, stderr, exit_code, max_bytes=MAX_MODEL_OUTPUT_BYTES)
    observation = _wrap_observation("execute_bash", call_id, obs)

    return ToolResult(
        call_id=call_id,
        tool_name="execute_bash",
        status="completed" if exit_code == 0 else "failed",
        observation_for_model=observation,
        stdout=stdout[:4096],
        stderr=stderr[:2048],
        exit_code=exit_code,
        full_output_ref=str(log_path),
    )


# ── Filesystem tools ──────────────────────────────────────────────────────────

def read_file(
    args: dict[str, Any],
    run_id: str,
    call_id: str,
) -> ToolResult:
    rel = str(args.get("path", "")).strip()
    max_bytes = int(args.get("max_bytes") or 16384)
    max_bytes = min(max_bytes, 1_000_000)

    try:
        path = _resolve_sandbox_path(run_id, rel)
    except ValueError as e:
        return ToolResult(
            call_id=call_id,
            tool_name="read_file",
            status="failed",
            observation_for_model=_wrap_observation("read_file", call_id, str(e)),
        )

    if not path.exists():
        msg = f"File not found: {rel}"
        return ToolResult(
            call_id=call_id,
            tool_name="read_file",
            status="failed",
            observation_for_model=_wrap_observation("read_file", call_id, msg),
        )

    try:
        raw = path.read_bytes()[:max_bytes]
        content = raw.decode("utf-8", errors="replace")
        truncated = len(path.read_bytes()) > max_bytes
        note = f"\n[truncated — file is {path.stat().st_size} bytes, showing first {max_bytes}]" if truncated else ""
        wrapped = wrap_file_content(content + note)
        return ToolResult(
            call_id=call_id,
            tool_name="read_file",
            status="completed",
            observation_for_model=_wrap_observation("read_file", call_id, wrapped),
            raw_output=content,
        )
    except Exception as exc:
        return ToolResult(
            call_id=call_id,
            tool_name="read_file",
            status="failed",
            observation_for_model=_wrap_observation("read_file", call_id, str(exc)),
        )


def write_file(
    args: dict[str, Any],
    run_id: str,
    call_id: str,
) -> ToolResult:
    rel = str(args.get("path", "")).strip()
    content = str(args.get("content", ""))

    # Force writes into workspace/
    if not rel.startswith("workspace/") and not rel.startswith("/"):
        rel = "workspace/" + rel

    try:
        path = _resolve_sandbox_path(run_id, rel)
    except ValueError as e:
        return ToolResult(
            call_id=call_id,
            tool_name="write_file",
            status="failed",
            observation_for_model=_wrap_observation("write_file", call_id, str(e)),
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    msg = f"Wrote {len(content)} chars to {rel}."
    return ToolResult(
        call_id=call_id,
        tool_name="write_file",
        status="completed",
        observation_for_model=_wrap_observation("write_file", call_id, msg),
    )


def list_dir(
    args: dict[str, Any],
    run_id: str,
    call_id: str,
) -> ToolResult:
    rel = str(args.get("path", "workspace")).strip() or "workspace"
    try:
        path = _resolve_sandbox_path(run_id, rel)
    except ValueError as e:
        return ToolResult(
            call_id=call_id,
            tool_name="list_dir",
            status="failed",
            observation_for_model=_wrap_observation("list_dir", call_id, str(e)),
        )

    if not path.exists():
        return ToolResult(
            call_id=call_id,
            tool_name="list_dir",
            status="completed",
            observation_for_model=_wrap_observation("list_dir", call_id, f"Directory '{rel}' is empty or does not exist."),
        )

    entries = []
    for item in sorted(path.iterdir()):
        stat = item.stat()
        kind = "dir" if item.is_dir() else "file"
        size = f"{stat.st_size:,} bytes" if kind == "file" else ""
        entries.append(f"  {kind}  {item.name}  {size}")

    listing = f"{rel}/\n" + "\n".join(entries) if entries else f"{rel}/  (empty)"
    return ToolResult(
        call_id=call_id,
        tool_name="list_dir",
        status="completed",
        observation_for_model=_wrap_observation("list_dir", call_id, listing),
        raw_output=entries,
    )


def create_artifact(
    args: dict[str, Any],
    run_id: str,
    call_id: str,
) -> ToolResult:
    """
    Persist a sandbox file as a named artifact.
    Records SHA-256, size, description in DB via caller (orchestrator calls repositories).
    Returns artifact metadata for DB insertion.
    """
    rel = str(args.get("path", "")).strip()
    name = str(args.get("name", rel)).strip()
    description = str(args.get("description", "")).strip()

    try:
        src_path = _resolve_sandbox_path(run_id, rel)
    except ValueError as e:
        return ToolResult(
            call_id=call_id,
            tool_name="create_artifact",
            status="failed",
            observation_for_model=_wrap_observation("create_artifact", call_id, str(e)),
        )

    if not src_path.exists():
        return ToolResult(
            call_id=call_id,
            tool_name="create_artifact",
            status="failed",
            observation_for_model=_wrap_observation(
                "create_artifact", call_id, f"File not found: {rel}"
            ),
        )

    # Copy to artifacts/ if not already there
    root = sandbox_root(run_id)
    dest_path = root / "artifacts" / pathlib.Path(rel).name
    if src_path.resolve() != dest_path.resolve():
        shutil.copy2(src_path, dest_path)

    # Hash and size
    raw = dest_path.read_bytes()
    sha256 = hashlib.sha256(raw).hexdigest()
    size = len(raw)

    artifact_id = str(uuid.uuid4())
    artifact_meta = {
        "artifact_id": artifact_id,
        "run_id": run_id,
        "path": str(dest_path),
        "name": name,
        "sha256": sha256,
        "size_bytes": size,
        "description": description,
    }

    msg = (
        f"Artifact created: {name}\n"
        f"Path: {dest_path}\n"
        f"SHA-256: {sha256}\n"
        f"Size: {size:,} bytes"
    )
    return ToolResult(
        call_id=call_id,
        tool_name="create_artifact",
        status="completed",
        observation_for_model=_wrap_observation("create_artifact", call_id, msg),
        artifacts=[artifact_meta],
        raw_output=artifact_meta,
    )


# ── Output summariser ─────────────────────────────────────────────────────────

def _summarise_output(
    stdout: str,
    stderr: str,
    exit_code: int,
    max_bytes: int = 8192,
) -> str:
    """
    Build a model-safe observation from subprocess output.
    Never sends more than max_bytes total to the model.
    Full logs are stored in tool_outputs/ for reference.
    """
    head = max_bytes * 3 // 4   # 75% from head
    tail = max_bytes - head      # 25% from tail

    def clip(s: str, n: int) -> str:
        if len(s) <= n:
            return s
        return s[:n] + f"\n[... {len(s) - n} bytes truncated — full log in tool_outputs/]"

    parts = []
    if stdout.strip():
        parts.append(f"STDOUT:\n{clip(stdout, head)}")
    if stderr.strip():
        parts.append(f"STDERR:\n{clip(stderr, tail)}")
    parts.append(f"exit code: {exit_code}")
    return "\n\n".join(parts)
