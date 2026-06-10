#!/usr/bin/env python3
"""Deploy stage 03/04 scripts, sub-workflows, and wire parent orchestrator."""

import base64
import json
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PARENT_ID = "jYFaI5YUWM8KhwTY"
WF03_ID = "ZSAN03Brisbane01"
WF04_ID = "ZCLA04Brisbane01"
PROJECT_ID = "PTLdxNJsT8UqtX3i"
ANTHROPIC_CRED_ID = "Ay5qCHySh8xYG1C4"

SCRIPTS_DIR = Path("/home/node/.n8n/scripts")
CONFIG_CONTAINER_DIR = SCRIPTS_DIR / "eofy-audit-config"

LIB_FILES = [
    "sanitise-core.js",
    "profile-core.js",
    "03_sanitise_profile.js",
    "04_claude_prepare.js",
    "04_claude_call_api.js",
    "04_claude_save_report.js",
]

CONFIG_FILES = [
    "audit-scope.json",
    "audit-tests.json",
    "join-keys.json",
    "claude-audit-system-prompt.txt",
]

MERGE_SANITISE_CODE = (ROOT / "lib/n8n_merge_context_for_sanitise.code.js").read_text().strip() + "\n"
MERGE_CLAUDE_CODE = (ROOT / "lib/n8n_merge_context_for_claude.code.js").read_text().strip() + "\n"
RETURN_CORE_CODE = (ROOT / "lib/n8n_return_core_result_final.code.js").read_text().strip() + "\n"


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


def deploy_scripts():
    run([
        "docker", "exec", "ghoststack-rag-n8n-1",
        "mkdir", "-p", str(CONFIG_CONTAINER_DIR),
    ])
    for name in LIB_FILES:
        run([
            "docker", "cp",
            str(ROOT / "lib" / name),
            f"ghoststack-rag-n8n-1:{SCRIPTS_DIR / name}",
        ])
    for name in CONFIG_FILES:
        run([
            "docker", "cp",
            str(ROOT / "config" / name),
            f"ghoststack-rag-n8n-1:{CONFIG_CONTAINER_DIR / name}",
        ])


def upsert_workflow(wf_id: str, wf_path: Path, name: str):
    wf = json.loads(wf_path.read_text())
    wf["name"] = name
    nodes = wf["nodes"]
    connections = wf["connections"]
    settings = wf.get("settings", {"executionOrder": "v1"})
    meta = wf.get("meta", {"instanceId": str(uuid.uuid4())})
    version_id = str(uuid.uuid4())

    exists = sql(f"SELECT 1 FROM workflow_entity WHERE id = '{wf_id}';")
    safe_name = name.replace("'", "''")

    if exists:
        stmt = (
            f"UPDATE workflow_entity SET "
            f"name = '{safe_name}', "
            f"nodes = {sql_json_from_b64(nodes)}, "
            f"connections = {sql_json_from_b64(connections)}, "
            f"settings = {sql_json_from_b64(settings)}, "
            f"meta = {sql_json_from_b64(meta)}, "
            f'"updatedAt" = NOW() '
            f"WHERE id = '{wf_id}';"
        )
    else:
        stmt = (
            f"INSERT INTO workflow_entity ("
            f"id, name, active, nodes, connections, settings, meta, \"versionId\", \"triggerCount\", \"isArchived\", \"versionCounter\""
            f") VALUES ("
            f"'{wf_id}', '{safe_name}', true, "
            f"{sql_json_from_b64(nodes)}, "
            f"{sql_json_from_b64(connections)}, "
            f"{sql_json_from_b64(settings)}, "
            f"{sql_json_from_b64(meta)}, "
            f"'{version_id}', 0, false, 1"
            f"); "
            f"INSERT INTO shared_workflow (\"workflowId\", \"projectId\", role) "
            f"VALUES ('{wf_id}', '{PROJECT_ID}', 'workflow:owner') "
            f"ON CONFLICT DO NOTHING;"
        )

    run([
        "docker", "exec", "ghoststack-rag-n8n-db-1",
        "psql", "-U", "n8n", "-d", "n8n", "-c", stmt,
    ])


def workflow_input_mapping():
    return {
        "mappingMode": "defineBelow",
        "value": {},
        "matchingColumns": [],
        "schema": [],
        "attemptToConvertTypes": False,
        "convertFieldsToString": False,
    }


def make_execute_sub_node(node_id, name, wf_id, wf_name, position, input_map):
    mapping = workflow_input_mapping()
    mapping["value"] = input_map
    return {
        "parameters": {
            "workflowId": {
                "__rl": True,
                "value": wf_id,
                "mode": "list",
                "cachedResultName": wf_name,
            },
            "workflowInputs": mapping,
            "options": {"waitForSubWorkflow": True},
        },
        "id": node_id,
        "name": name,
        "type": "n8n-nodes-base.executeWorkflow",
        "typeVersion": 1.3,
        "position": position,
    }


def update_parent(wf03_id: str, wf04_id: str):
    nodes = json.loads(sql(f"SELECT nodes::text FROM workflow_entity WHERE id = '{PARENT_ID}';"))
    connections = json.loads(sql(f"SELECT connections::text FROM workflow_entity WHERE id = '{PARENT_ID}';"))

    for n in nodes:
        if n.get("name") == "Core Run Config":
            assignments = n["parameters"]["assignments"]["assignments"]
            by_name = {a["name"]: a for a in assignments}
            defaults = {
                "subworkflow_03_sanitise_profile_id": wf03_id,
                "subworkflow_04_claude_audit_id": wf04_id,
                "claude_model": "claude-sonnet-4-20250514",
            }
            for key, val in defaults.items():
                if key in by_name:
                    by_name[key]["value"] = val
                else:
                    assignments.append({
                        "id": key,
                        "name": key,
                        "value": val,
                        "type": "string",
                    })

        if n.get("name") == "Build Snapshot Context":
            code = n["parameters"]["jsCode"]
            if "subworkflow_03_sanitise_profile_id" not in code:
                code = code.replace(
                    "subworkflow_02_pos_retail_id: cfg.subworkflow_02_pos_retail_id || required('subworkflow_02_pos_retail_id'),",
                    "subworkflow_02_pos_retail_id: cfg.subworkflow_02_pos_retail_id || required('subworkflow_02_pos_retail_id'),\n\n    subworkflow_03_sanitise_profile_id: cfg.subworkflow_03_sanitise_profile_id || required('subworkflow_03_sanitise_profile_id'),\n    subworkflow_04_claude_audit_id: cfg.subworkflow_04_claude_audit_id || required('subworkflow_04_claude_audit_id'),\n    claude_model: cfg.claude_model || 'claude-sonnet-4-20250514',",
                )
                n["parameters"]["jsCode"] = code

    # positions for horizontal chain
    positions = {
        "Run 01 Sub - Account Ledger": [-304, -224],
        "Merge Context for POS": [-208, -224],
        "Run 02 Sub - POS Retail": [-96, -224],
        "Merge Context for Sanitise": [8, -224],
        "Run 03 Sub - Sanitise Profile": [104, -224],
        "Merge Context for Claude": [200, -224],
        "Run 04 Sub - Claude Audit": [296, -224],
        "Return Core Result": [400, -224],
    }
    for n in nodes:
        if n.get("name") in positions:
            n["position"] = positions[n["name"]]

    if not any(n.get("name") == "Merge Context for Sanitise" for n in nodes):
        nodes.append({
            "parameters": {"jsCode": MERGE_SANITISE_CODE},
            "id": "b03merge-sanitise",
            "name": "Merge Context for Sanitise",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": positions["Merge Context for Sanitise"],
        })

    if not any(n.get("name") == "Run 03 Sub - Sanitise Profile" for n in nodes):
        nodes.append(
            make_execute_sub_node(
                "b03run-sanitise-sub",
                "Run 03 Sub - Sanitise Profile",
                wf03_id,
                "03_SUB_SANITISE_PROFILE",
                positions["Run 03 Sub - Sanitise Profile"],
                {
                    "snapshot_id": "={{$json.snapshot_id}}",
                    "output_root": "={{$json.output_root}}",
                },
            )
        )

    if not any(n.get("name") == "Merge Context for Claude" for n in nodes):
        nodes.append({
            "parameters": {"jsCode": MERGE_CLAUDE_CODE},
            "id": "b04merge-claude",
            "name": "Merge Context for Claude",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": positions["Merge Context for Claude"],
        })

    if not any(n.get("name") == "Run 04 Sub - Claude Audit" for n in nodes):
        nodes.append(
            make_execute_sub_node(
                "b04run-claude-sub",
                "Run 04 Sub - Claude Audit",
                wf04_id,
                "04_SUB_CLAUDE_AUDIT",
                positions["Run 04 Sub - Claude Audit"],
                {
                    "snapshot_id": "={{$json.snapshot_id}}",
                    "output_root": "={{$json.output_root}}",
                    "claude_model": "={{$json.claude_model}}",
                    "max_sample_per_model": "={{$json.max_sample_per_model}}",
                },
            )
        )

    for n in nodes:
        if n.get("name") == "Run 03 Sub - Sanitise Profile":
            n["parameters"]["workflowId"]["value"] = wf03_id
        if n.get("name") == "Run 04 Sub - Claude Audit":
            n["parameters"]["workflowId"]["value"] = wf04_id
        if n.get("name") == "Return Core Result":
            n["parameters"]["jsCode"] = RETURN_CORE_CODE

    connections["Run 02 Sub - POS Retail"] = {
        "main": [[{"node": "Merge Context for Sanitise", "type": "main", "index": 0}]],
    }
    connections["Merge Context for Sanitise"] = {
        "main": [[{"node": "Run 03 Sub - Sanitise Profile", "type": "main", "index": 0}]],
    }
    connections["Run 03 Sub - Sanitise Profile"] = {
        "main": [[{"node": "Merge Context for Claude", "type": "main", "index": 0}]],
    }
    connections["Merge Context for Claude"] = {
        "main": [[{"node": "Run 04 Sub - Claude Audit", "type": "main", "index": 0}]],
    }
    connections["Run 04 Sub - Claude Audit"] = {
        "main": [[{"node": "Return Core Result", "type": "main", "index": 0}]],
    }

    stmt = (
        f"UPDATE workflow_entity SET "
        f"nodes = {sql_json_from_b64(nodes)}, "
        f"connections = {sql_json_from_b64(connections)}, "
        f'"updatedAt" = NOW() '
        f"WHERE id = '{PARENT_ID}';"
    )
    run([
        "docker", "exec", "ghoststack-rag-n8n-db-1",
        "psql", "-U", "n8n", "-d", "n8n", "-c", stmt,
    ])


def main():
    deploy_scripts()
    upsert_workflow(
        WF03_ID,
        ROOT / "workflows/03-brisbane-eofy-sanitise-profile-sub.workflow.json",
        "03_SUB_SANITISE_PROFILE",
    )
    upsert_workflow(
        WF04_ID,
        ROOT / "workflows/04-brisbane-eofy-claude-audit-sub.workflow.json",
        "04_SUB_CLAUDE_AUDIT",
    )
    update_parent(WF03_ID, WF04_ID)

    print("Deployed stages 03 and 04.")
    print(f"  03_SUB_SANITISE_PROFILE: {WF03_ID}")
    print(f"  04_SUB_CLAUDE_AUDIT: {WF04_ID}")
    print(f"  Parent orchestrator: {PARENT_ID}")
    print("Refresh n8n UI, then run parent workflow end-to-end.")


if __name__ == "__main__":
    main()
