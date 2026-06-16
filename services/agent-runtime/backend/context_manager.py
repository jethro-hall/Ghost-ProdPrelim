"""
Context manager — assembles the prompt for each LLM call.

Rules:
- Never injects raw dataset rows, full Parquet contents, or stdout logs.
- Only includes: system contract, recent observations, current plan, tool schemas, artifact manifest.
- Token budget is managed by capping recent observations.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from .config import get_settings
from .repositories import get_artifacts, get_run_events
from .tool_registry import all_tools

logger = logging.getLogger(__name__)
_settings = get_settings()

# The complete system contract — NOTHING ELSE added here.
# No finance methodology. No static instructions. Just operational rules.
SYSTEM_CONTRACT = """You are an autonomous analysis agent operating inside a controlled runtime.

You do not have direct access to files, databases, shell, Python, or external systems.
You may only act by calling available tools.

Rules:
1. Inspect available data, schemas, and tool results before making claims.
2. Choose tools dynamically based on the task.
3. Generate code only when needed, and only for the current task.
4. Do not fabricate numbers, fields, tables, relationships, or outputs.
5. Keep large data outside the prompt. Use files, manifests, catalogs, and tool calls.
6. After material work, verify the result using independent checks.
7. Before final answer, state what was verified and what remains uncertain.
8. Do not reveal hidden reasoning. Provide concise plans, observations, and conclusions.

GPU ANALYTICS — COPY THIS EXACT PATTERN (it works):
  import httpx, os, json
  url = os.environ.get('RAPIDS_URL', 'http://rapids-analytics:8010')
  script = 'df = gf("c3_fy2025_account_move_line")\\nresult = {"rows": len(df), "debit": float(df["debit"].sum())}'
  r = httpx.post(url + '/execute', json={'script': script}, timeout=20)
  data = r.json()
  print(json.dumps(data.get('result') or {'error': data.get('error','?')}))

For groupby aggregation:
  script = '''df = gf("c3_fy2025_account_move_line")
grp = df.groupby("account_id_name")["credit"].sum().to_pandas()
top5 = grp.nlargest(5).to_dict()
result = top5'''"""

# Max recent observations to include in context (approx token budget management)
MAX_RECENT_OBSERVATIONS = 10
MAX_OBSERVATION_CHARS = 2000  # per observation


def build_prompt(
    run_id: str,
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Build the full prompt context for one Bedrock Converse call.

    Returns:
        {
            "system": str,
            "messages": list of Bedrock messages,
            "artifact_manifest": list of artifact metadata,
        }
    """
    # Artifact manifest (paths + sha256 + descriptions — never file contents)
    artifacts = get_artifacts(run_id)
    manifest = [
        {
            "name": a["name"],
            "path": a["path"],
            "sha256": a["sha256"],
            "size_bytes": a["size_bytes"],
            "description": a.get("description", ""),
        }
        for a in artifacts
    ]

    # Append artifact manifest note to system if any artifacts exist
    system = SYSTEM_CONTRACT
    if manifest:
        manifest_text = "\n".join(
            f"  - {m['name']} ({m['size_bytes']:,} bytes, sha256: {m['sha256'][:8]}...): {m['description']}"
            for m in manifest
        )
        system += (
            f"\n\nCurrent run artifacts (use read_file or execute_python to inspect):\n"
            f"{manifest_text}"
        )

    return {
        "system": system,
        "messages": messages,
        "artifact_manifest": manifest,
    }


def build_system_content() -> list[dict[str, str]]:
    """Return Bedrock-format system content."""
    return [{"text": SYSTEM_CONTRACT}]


def tool_schemas_for_bedrock() -> list[dict[str, Any]]:
    """Return all registered tools in Bedrock Converse toolSpec format."""
    tools = []
    for t in all_tools():
        tools.append(
            {
                "toolSpec": {
                    "name": t.name,
                    "description": t.description,
                    "inputSchema": {"json": t.json_schema},
                }
            }
        )
    return tools
