#!/usr/bin/env python3
"""Set execution timeouts on EOFY orchestrator + sub-workflows (fixes 60s cancel)."""

import json
import subprocess

# Full pipeline can run 40+ minutes; stage 01 alone is often 60-140s.
ORCHESTRATOR_ID = "jYFaI5YUWM8KhwTY"
ORCHESTRATOR_TIMEOUT = 14400  # 4 hours

SUB_WORKFLOWS = [
    ("1HXbApqBqDVNVbCa", "01_SUB_ACCOUNT_LEDGER", 3600),
    ("ZPOS02Brisbane01", "02_SUB_POS_RETAIL", 3600),
    ("ZSAN03Brisbane01", "03_SUB_SANITISE_PROFILE", 7200),
    ("ZCLA04Brisbane01", "04_SUB_CLAUDE_AUDIT", 3600),
    ("EFsI0LxP80vcl0jk", "05_SUB_MASTER_DATA", 3600),
    ("ZRAW06Brisbane01", "06_SUB_RAW_GITHUB_PUSH", 3600),
]


def sql(query: str) -> str:
    return subprocess.check_output(
        [
            "docker", "exec", "ghoststack-rag-n8n-db-1",
            "psql", "-U", "n8n", "-d", "n8n", "-t", "-A", "-c", query,
        ],
        text=True,
    ).strip()


def set_timeout(workflow_id: str, seconds: int) -> None:
    sql(
        f"UPDATE workflow_entity "
        f"SET settings = COALESCE(settings, '{{}}'::json)::jsonb || "
        f"jsonb_build_object('executionTimeout', {seconds}) "
        f"WHERE id = '{workflow_id}';"
    )


def main() -> None:
    set_timeout(ORCHESTRATOR_ID, ORCHESTRATOR_TIMEOUT)
    print(f"✓ Orchestrator timeout → {ORCHESTRATOR_TIMEOUT}s (was 60s)")

    for wf_id, name, timeout in SUB_WORKFLOWS:
        set_timeout(wf_id, timeout)
        print(f"✓ {name} timeout → {timeout}s")

    print("\nVerify:")
    print(sql(
        "SELECT name, settings->>'executionTimeout' FROM workflow_entity "
        "WHERE id IN ('jYFaI5YUWM8KhwTY','1HXbApqBqDVNVbCa','ZSAN03Brisbane01') ORDER BY name;"
    ))


if __name__ == "__main__":
    main()
