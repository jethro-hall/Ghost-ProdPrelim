#!/usr/bin/env python3
"""Deploy FY period human gate to 00_START_HERE orchestrator workflow."""

import base64
import json
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PARENT_ID = "jYFaI5YUWM8KhwTY"
WF04_ID = "ZCLA04Brisbane01"
WF06_ID = "ZRAW06Brisbane01"
WAIT_WEBHOOK_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

VALIDATE_CODE = (ROOT / "lib/n8n_validate_period_gate.code.js").read_text().strip() + "\n"
BUILD_CTX_CODE = (ROOT / "lib/n8n_build_snapshot_context.code.js").read_text().strip() + "\n"
EXPORT_PATH = ROOT / "workflows/00-brisbane-eofy-orchestrator.workflow.json"


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


def load_parent():
    nodes = json.loads(sql(f"SELECT nodes::text FROM workflow_entity WHERE id = '{PARENT_ID}';"))
    connections = json.loads(sql(f"SELECT connections::text FROM workflow_entity WHERE id = '{PARENT_ID}';"))
    name = sql(f"SELECT name FROM workflow_entity WHERE id = '{PARENT_ID}';")
    return nodes, connections, name


def node_by_name(nodes, name):
    for n in nodes:
        if n.get("name") == name:
            return n
    return None


def upsert_node(nodes, node):
    for i, n in enumerate(nodes):
        if n.get("id") == node["id"]:
            nodes[i] = node
            return
    nodes.append(node)


def update_orchestrator(nodes, connections):
    core = node_by_name(nodes, "Core Run Config")
    if not core:
        raise RuntimeError("Core Run Config node not found")

    # Remove date_start/date_end from Core Run Config
    assignments = [
        a for a in core["parameters"]["assignments"]["assignments"]
        if a["name"] not in ("date_start", "date_end")
    ]

    # Fix Stage 04/06 subworkflow IDs if corrupted
    has_wf06 = any(a["name"] == "subworkflow_06_raw_github_push_id" for a in assignments)
    for a in assignments:
        if a["name"] == "subworkflow_04_claude_audit_id":
            a["value"] = WF04_ID
    if not has_wf06:
        assignments.append({
            "id": "subworkflow_06_raw_github_push_id",
            "name": "subworkflow_06_raw_github_push_id",
            "type": "string",
            "value": WF06_ID,
        })
    core["parameters"]["assignments"]["assignments"] = assignments

    # Select Audit Period Set node
    upsert_node(nodes, {
        "parameters": {
            "mode": "manual",
            "duplicateItem": False,
            "assignments": {
                "assignments": [
                    {"id": "date_start", "name": "date_start", "type": "string", "value": "2024-07-01"},
                    {"id": "date_end", "name": "date_end", "type": "string", "value": "2025-06-30"},
                    {"id": "period_label", "name": "period_label", "type": "string", "value": ""},
                    {"id": "snapshot_id", "name": "snapshot_id", "type": "string", "value": ""},
                ],
            },
            "options": {"includeOtherFields": True},
        },
        "id": "b00select-audit-period",
        "name": "Select Audit Period",
        "type": "n8n-nodes-base.set",
        "typeVersion": 3.4,
        "position": [-880, -160],
    })

    upsert_node(nodes, {
        "parameters": {"jsCode": VALIDATE_CODE},
        "id": "b00validate-period",
        "name": "Validate And Preview Period",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [-704, -160],
    })

    upsert_node(nodes, {
        "parameters": {"resume": "webhook", "options": {}},
        "id": "b00confirm-period-wait",
        "name": "Confirm Period — Wait",
        "type": "n8n-nodes-base.wait",
        "typeVersion": 1.1,
        "position": [-528, -160],
        "webhookId": WAIT_WEBHOOK_ID,
    })

    build = node_by_name(nodes, "Build Snapshot Context")
    if not build:
        raise RuntimeError("Build Snapshot Context node not found")
    build["parameters"]["jsCode"] = BUILD_CTX_CODE
    build["position"] = [-352, -160]

    return_core = node_by_name(nodes, "Return Core Result")
    if return_core:
        return_core["parameters"]["jsCode"] = (
            (ROOT / "lib/n8n_return_core_result_with_raw_push.code.js").read_text().strip() + "\n"
        )

    upsert_node(nodes, {
        "parameters": {
            "jsCode": (
                "const ctx = $('Build Snapshot Context').first().json;\n"
                "const githubPush = $('Run 04 Sub - Claude Audit').first().json;\n"
                "return [{ json: {\n"
                "  snapshot_id: githubPush.snapshot_id || ctx.snapshot_id,\n"
                "  output_root: ctx.output_root || '/home/node/.n8n/odoo_forensic_exports',\n"
                "} }];\n"
            ),
        },
        "id": "b06merge-raw-push",
        "name": "Merge Context for Raw Push",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [1248, -144],
    })

    upsert_node(nodes, {
        "parameters": {
            "options": {"waitForSubWorkflow": True},
            "workflowId": {
                "__rl": True,
                "mode": "list",
                "value": WF06_ID,
                "cachedResultName": "06_SUB_RAW_GITHUB_PUSH",
            },
            "workflowInputs": {
                "value": {
                    "output_root": "={{$json.output_root}}",
                    "snapshot_id": "={{$json.snapshot_id}}",
                },
                "schema": [],
                "mappingMode": "defineBelow",
                "matchingColumns": [],
                "attemptToConvertTypes": False,
                "convertFieldsToString": False,
            },
        },
        "id": "b06run-raw-push-sub",
        "name": "Run 06 Sub - Raw GitHub Push",
        "type": "n8n-nodes-base.executeWorkflow",
        "typeVersion": 1.3,
        "position": [1424, -272],
    })

    # Sticky note for period gate
    upsert_node(nodes, {
        "parameters": {
            "content": "## Period Gate\n\n1. Edit **Select Audit Period** before Execute:\n   - FY24/25: `2024-07-01` → `2025-06-30`\n   - FY23/24: `2023-07-01` → `2024-06-30`\n2. Execute workflow\n3. Review **Validate And Preview Period** output\n4. Click **Resume** on **Confirm Period — Wait**\n5. Extraction starts only after Resume",
            "height": 280,
            "width": 420,
            "color": 4,
        },
        "id": "b00sticky-period-gate",
        "name": "README - Period Gate",
        "type": "n8n-nodes-base.stickyNote",
        "typeVersion": 1,
        "position": [-920, -480],
    })

    connections.clear()
    connections.update({
        "Manual Trigger": {"main": [[{"node": "Core Run Config", "type": "main", "index": 0}]]},
        "Core Run Config": {"main": [[{"node": "Select Audit Period", "type": "main", "index": 0}]]},
        "Select Audit Period": {"main": [[{"node": "Validate And Preview Period", "type": "main", "index": 0}]]},
        "Validate And Preview Period": {"main": [[{"node": "Confirm Period — Wait", "type": "main", "index": 0}]]},
        "Confirm Period — Wait": {"main": [[{"node": "Build Snapshot Context", "type": "main", "index": 0}]]},
        "Build Snapshot Context": {"main": [[{"node": "Run 01 Sub - Account Ledger", "type": "main", "index": 0}]]},
        "Run 01 Sub - Account Ledger": {"main": [[{"node": "Merge Context for POS", "type": "main", "index": 0}]]},
        "Merge Context for POS": {"main": [[{"node": "Run 02 Sub - POS Retail", "type": "main", "index": 0}]]},
        "Run 02 Sub - POS Retail": {"main": [[{"node": "Merge Context for Sanitise", "type": "main", "index": 0}]]},
        "Merge Context for Sanitise": {"main": [[{"node": "Run 03 Sub - Sanitise Profile", "type": "main", "index": 0}]]},
        "Run 03 Sub - Sanitise Profile": {"main": [[{"node": "Merge Context for Master Data", "type": "main", "index": 0}]]},
        "Merge Context for Master Data": {"main": [[{"node": "Run 05 Sub - Master Data", "type": "main", "index": 0}]]},
        "Run 05 Sub - Master Data": {"main": [[{"node": "Merge Context for Claude", "type": "main", "index": 0}]]},
        "Merge Context for Claude": {"main": [[{"node": "Run 04 Sub - Claude Audit", "type": "main", "index": 0}]]},
        "Run 04 Sub - Claude Audit": {"main": [[{"node": "Merge Context for Raw Push", "type": "main", "index": 0}]]},
        "Merge Context for Raw Push": {"main": [[{"node": "Run 06 Sub - Raw GitHub Push", "type": "main", "index": 0}]]},
        "Run 06 Sub - Raw GitHub Push": {"main": [[{"node": "Return Core Result", "type": "main", "index": 0}]]},
    })

    return nodes, connections


def publish(nodes, connections, name):
    new_vid = str(uuid.uuid4())
    nodes_sql = sql_json_from_b64(nodes)
    conns_sql = sql_json_from_b64(connections)
    run([
        "docker", "exec", "ghoststack-rag-n8n-db-1", "psql", "-U", "n8n", "-d", "n8n", "-c",
        f"""
        UPDATE workflow_entity SET
          nodes = {nodes_sql},
          connections = {conns_sql},
          "updatedAt" = NOW()
        WHERE id = '{PARENT_ID}';

        INSERT INTO workflow_history ("versionId", "workflowId", authors, nodes, connections, name, autosaved)
        VALUES ('{new_vid}', '{PARENT_ID}', 'system', {nodes_sql}, {conns_sql}, '{name}', false);

        UPDATE workflow_published_version SET "publishedVersionId" = '{new_vid}', "updatedAt" = NOW()
        WHERE "workflowId" = '{PARENT_ID}';

        UPDATE workflow_entity SET "versionId" = '{new_vid}', "updatedAt" = NOW()
        WHERE id = '{PARENT_ID}';
        """,
    ])
    print(f"Published orchestrator versionId={new_vid}")


def export_workflow(nodes, connections, name):
    EXPORT_PATH.write_text(json.dumps({
        "name": name,
        "nodes": nodes,
        "connections": connections,
        "settings": {"executionOrder": "v1"},
    }, indent=2) + "\n")
    print(f"Exported {EXPORT_PATH}")


def main():
    nodes, connections, name = load_parent()
    nodes, connections = update_orchestrator(nodes, connections)
    publish(nodes, connections, name)
    export_workflow(nodes, connections, name)
    print("Done: FY period human gate deployed to orchestrator")


if __name__ == "__main__":
    main()
