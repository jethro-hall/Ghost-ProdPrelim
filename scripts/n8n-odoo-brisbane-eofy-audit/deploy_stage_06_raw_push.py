#!/usr/bin/env python3
"""Deploy Stage 06 raw GitHub push script and sub-workflow."""

import base64
import json
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WF06_ID = "ZRAW06Brisbane01"
PROJECT_ID = "PTLdxNJsT8UqtX3i"
SCRIPTS_DIR = Path("/home/node/.n8n/scripts")


def run(cmd, **kw):
    print("+", " ".join(cmd))
    return subprocess.run(cmd, check=True, text=True, capture_output=True, **kw)


def sql(sql_text):
    return subprocess.check_output(
        [
            "docker", "exec", "ghoststack-rag-n8n-db-1",
            "psql", "-U", "n8n", "-d", "n8n", "-t", "-A", "-c", sql_text,
        ],
        text=True,
    ).strip()


def sql_json_from_b64(value) -> str:
    payload = base64.b64encode(json.dumps(value).encode("utf-8")).decode("ascii")
    return f"convert_from(decode('{payload}', 'base64'), 'utf8')::json"


def deploy_script():
    run([
        "docker", "cp",
        str(ROOT / "lib/06_raw_github_push.js"),
        f"ghoststack-rag-n8n-1:{SCRIPTS_DIR / '06_raw_github_push.js'}",
    ])


def upsert_workflow():
    wf = json.loads((ROOT / "workflows/06-brisbane-eofy-raw-github-push-sub.workflow.json").read_text())
    wf["name"] = "06_SUB_RAW_GITHUB_PUSH"
    nodes = wf["nodes"]
    connections = wf["connections"]
    settings = wf.get("settings", {"executionOrder": "v1", "executionTimeout": 3600})
    meta = wf.get("meta", {"instanceId": str(uuid.uuid4())})
    version_id = str(uuid.uuid4())
    exists = sql(f"SELECT 1 FROM workflow_entity WHERE id = '{WF06_ID}';")
    safe_name = "06_SUB_RAW_GITHUB_PUSH".replace("'", "''")

    if exists:
        stmt = (
            f"UPDATE workflow_entity SET "
            f"name = '{safe_name}', "
            f"nodes = {sql_json_from_b64(nodes)}, "
            f"connections = {sql_json_from_b64(connections)}, "
            f"settings = {sql_json_from_b64(settings)}, "
            f"meta = {sql_json_from_b64(meta)}, "
            f'"updatedAt" = NOW() '
            f"WHERE id = '{WF06_ID}';"
        )
    else:
        stmt = (
            f"INSERT INTO workflow_entity (id, name, active, nodes, connections, settings, \"staticData\", meta, \"createdAt\", \"updatedAt\", \"versionId\", \"triggerCount\", \"isArchived\", \"versionCounter\", \"parentFolderId\", \"description\") "
            f"VALUES ('{WF06_ID}', '{safe_name}', true, {sql_json_from_b64(nodes)}, {sql_json_from_b64(connections)}, "
            f"{sql_json_from_b64(settings)}, null, {sql_json_from_b64(meta)}, NOW(), NOW(), '{version_id}', 0, false, 1, null, null);"
        )

    run(["docker", "exec", "ghoststack-rag-n8n-db-1", "psql", "-U", "n8n", "-d", "n8n", "-c", stmt])

    shared = sql(f"SELECT 1 FROM shared_workflow WHERE \"workflowId\" = '{WF06_ID}';")
    if not shared:
        run([
            "docker", "exec", "ghoststack-rag-n8n-db-1", "psql", "-U", "n8n", "-d", "n8n", "-c",
            f"INSERT INTO shared_workflow (\"workflowId\", \"projectId\", role, \"createdAt\", \"updatedAt\") "
            f"VALUES ('{WF06_ID}', '{PROJECT_ID}', 'workflow:owner', NOW(), NOW());",
        ])

    print(f"Deployed workflow {WF06_ID}")


def main():
    deploy_script()
    upsert_workflow()
    print("Done: Stage 06 raw GitHub push deployed")


if __name__ == "__main__":
    main()
