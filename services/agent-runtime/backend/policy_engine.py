"""
Policy engine — risk classification and approval gate.

The policy engine evaluates every tool call BEFORE execution.
It never lets the LLM bypass this gate.
"""
from __future__ import annotations

import dataclasses
from typing import Any

from .tool_registry import get_tool, needs_approval


@dataclasses.dataclass
class PolicyDecision:
    tool_name: str
    risk_level: str          # "low" | "medium" | "high" | "critical"
    requires_approval: bool
    block_reason: str | None = None  # non-None means hard block, no approval possible


_HARD_BLOCKED: set[str] = frozenset(
    {
        # Prevent escape from sandbox
        "exec", "eval",
    }
)

_DESTRUCTIVE_BASH_PATTERNS: list[str] = [
    "rm -rf", "rm -r /", "rm -f /",
    "dd if=", "mkfs", "> /dev/", "shred",
    "chmod -R 777 /", "chown -R",
    "iptables", "ufw", "firewall",
    "systemctl stop", "service stop",
    "reboot", "shutdown", "halt",
    "kill -9 1",
]


def evaluate(tool_name: str, args: dict[str, Any]) -> PolicyDecision:
    """Classify the tool call and decide whether approval is required."""

    # Hard block list
    if tool_name in _HARD_BLOCKED:
        return PolicyDecision(
            tool_name=tool_name,
            risk_level="critical",
            requires_approval=False,
            block_reason=f"Tool '{tool_name}' is permanently blocked by security policy.",
        )

    tool = get_tool(tool_name)
    if tool is None:
        return PolicyDecision(
            tool_name=tool_name,
            risk_level="high",
            requires_approval=True,
            block_reason=f"Unknown tool '{tool_name}'.",
        )

    # Bash: check for severely destructive patterns that should be blocked entirely
    if tool_name == "execute_bash":
        cmd = str(args.get("cmd", "")).lower()
        for pat in _DESTRUCTIVE_BASH_PATTERNS:
            if pat in cmd:
                return PolicyDecision(
                    tool_name=tool_name,
                    risk_level="critical",
                    requires_approval=False,
                    block_reason=(
                        f"Command matches blocked destructive pattern: '{pat}'. "
                        "This pattern is hard-blocked regardless of approval."
                    ),
                )

    # Normal approval check
    approval_needed = needs_approval(tool_name, args)
    risk = _classify_risk(tool_name, args)

    return PolicyDecision(
        tool_name=tool_name,
        risk_level=risk,
        requires_approval=approval_needed,
    )


def _classify_risk(tool_name: str, args: dict[str, Any]) -> str:
    if tool_name in ("catalog_data_sources", "inspect_schema", "list_dir", "read_file"):
        return "low"
    if tool_name in ("query_data",):
        return "low"
    if tool_name in ("write_file", "create_artifact", "submit_for_review"):
        return "medium"
    if tool_name in ("execute_python",):
        return "medium"
    if tool_name == "execute_bash":
        cmd = str(args.get("cmd", "")).lower()
        if any(p in cmd for p in ["rm ", "mv ", "pip ", "curl ", "wget "]):
            return "high"
        return "medium"
    if tool_name == "request_approval":
        return args.get("risk_level", "medium")
    return "medium"
