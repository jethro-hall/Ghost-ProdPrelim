#!/usr/bin/env python3
"""Deploy 02 POS retail sub-workflow and wire parent orchestrator."""

import json
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent

WRITE_CODE = (ROOT / "lib/n8n_write_exporter_input_pos.code.js").read_text()
PARSE_CODE = """
const item = $input.first().json;

if (item.exitCode !== undefined && Number(item.exitCode) !== 0) {
  throw new Error(
    `POS retail exporter failed (exit ${item.exitCode}). stderr: ${item.stderr || ''}`,
  );
}

const stdout = String(item.stdout || '').trim();
if (!stdout) {
  throw new Error(
    `POS retail exporter returned empty stdout. stderr: ${item.stderr || ''}`,
  );
}

const lastLine = stdout.split(/\\r?\\n/).filter(Boolean).pop();

try {
  return [{ json: JSON.parse(lastLine) }];
} catch (e) {
  throw new Error(
    `Could not parse POS exporter stdout as JSON: ${e.message}. stdout starts: ${stdout.slice(0, 500)}`,
  );
}
""".strip() + "\n"

# strip comment-only lines from write code
write_lines = []
for line in WRITE_CODE.splitlines():
    if line.strip().startswith("//"):
        continue
    write_lines.append(line)
WRITE_JS = "\n".join(write_lines).strip() + "\n"

WORKFLOW = {
    "name": "02_SUB_POS_RETAIL",
    "nodes": [
        {
            "parameters": {"inputSource": "passthrough"},
            "id": str(uuid.uuid4()),
            "name": "When Executed by Core",
            "type": "n8n-nodes-base.executeWorkflowTrigger",
            "typeVersion": 1.1,
            "position": [-240, 256],
        },
        {
            "parameters": {"jsCode": WRITE_JS},
            "id": str(uuid.uuid4()),
            "name": "Write exporter input JSON",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [-16, 256],
        },
        {
            "parameters": {"command": "node /home/node/.n8n/scripts/02_pos_retail_exporter.js"},
            "id": str(uuid.uuid4()),
            "name": "Run POS Retail Exporter",
            "type": "n8n-nodes-base.executeCommand",
            "typeVersion": 1,
            "position": [208, 256],
        },
        {
            "parameters": {"jsCode": PARSE_CODE},
            "id": str(uuid.uuid4()),
            "name": "Parse Exporter Result",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [432, 256],
        },
    ],
    "connections": {
        "When Executed by Core": {
            "main": [[{"node": "Write exporter input JSON", "type": "main", "index": 0}]],
        },
        "Write exporter input JSON": {
            "main": [[{"node": "Run POS Retail Exporter", "type": "main", "index": 0}]],
        },
        "Run POS Retail Exporter": {
            "main": [[{"node": "Parse Exporter Result", "type": "main", "index": 0}]],
        },
    },
    "settings": {"executionOrder": "v1"},
    "meta": {"instanceId": str(uuid.uuid4())},
}

# stable node ids for connections - regenerate with fixed ids
ids = {
    "trigger": "a02trigger-pos-retail",
    "write": "a02write-input-json",
    "run": "a02run-pos-exporter",
    "parse": "a02parse-result",
}
for n in WORKFLOW["nodes"]:
    if n["name"] == "When Executed by Core":
        n["id"] = ids["trigger"]
    elif n["name"] == "Write exporter input JSON":
        n["id"] = ids["write"]
    elif n["name"] == "Run POS Retail Exporter":
        n["id"] = ids["run"]
    elif n["name"] == "Parse Exporter Result":
        n["id"] = ids["parse"]

WF_PATH = ROOT / "workflows/02-brisbane-eofy-pos-retail.workflow.json"
WF_PATH.write_text(json.dumps(WORKFLOW, indent=2))


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


def main():
    exporter = ROOT / "lib/02_pos_retail_exporter.js"
    run([
        "docker", "cp",
        str(exporter),
        "ghoststack-rag-n8n-1:/home/node/.n8n/scripts/02_pos_retail_exporter.js",
    ])
    run([
        "docker", "cp",
        str(WF_PATH),
        "ghoststack-rag-n8n-1:/tmp/02_pos_retail.workflow.json",
    ])

    user_id = "9dfb64d4-2aa4-4c5e-81e5-54625da1556c"
    run([
        "docker", "exec", "ghoststack-rag-n8n-1",
        "n8n", "import:workflow",
        "--input=/tmp/02_pos_retail.workflow.json",
        f"--userId={user_id}",
    ])

    wf_id = sql(
        "SELECT id FROM workflow_entity WHERE name = '02_SUB_POS_RETAIL' ORDER BY \"updatedAt\" DESC LIMIT 1;"
    )
    if not wf_id:
        raise SystemExit("Import failed: workflow not found in DB")
    print(f"Imported workflow id: {wf_id}")

    # Update parent orchestrator
    parent_id = "jYFaI5YUWM8KhwTY"
    raw = sql(f"SELECT nodes, connections FROM workflow_entity WHERE id = '{parent_id}';")
    nodes_json, conn_json = raw.split("|", 1)
    nodes = json.loads(nodes_json)
    connections = json.loads(conn_json)

    # Add subworkflow_02 to Core Run Config if missing
    for n in nodes:
        if n.get("name") == "Core Run Config":
            assignments = n["parameters"]["assignments"]["assignments"]
            names = {a["name"] for a in assignments}
            if "subworkflow_02_pos_retail_id" not in names:
                assignments.append({
                    "id": "subworkflow_02_pos_retail_id",
                    "name": "subworkflow_02_pos_retail_id",
                    "value": wf_id,
                    "type": "string",
                })
            else:
                for a in assignments:
                    if a["name"] == "subworkflow_02_pos_retail_id":
                        a["value"] = wf_id

    # Add Build Snapshot Context field for subworkflow_02
    for n in nodes:
        if n.get("name") == "Build Snapshot Context":
            code = n["parameters"]["jsCode"]
            if "subworkflow_02_pos_retail_id" not in code:
                n["parameters"]["jsCode"] = code.replace(
                    "subworkflow_01_account_ledger_id: required('subworkflow_01_account_ledger_id'),",
                    "subworkflow_01_account_ledger_id: required('subworkflow_01_account_ledger_id'),\n\n    subworkflow_02_pos_retail_id: cfg.subworkflow_02_pos_retail_id || required('subworkflow_02_pos_retail_id'),",
                )

    run02_id = "b02run-pos-retail-sub"
    has_run02 = any(n.get("name") == "Run 02 Sub - POS Retail" for n in nodes)
    if not has_run02:
        nodes.append({
            "parameters": {
                "workflowId": {
                    "__rl": True,
                    "value": wf_id,
                    "mode": "list",
                    "cachedResultName": "02_SUB_POS_RETAIL",
                },
                "workflowInputs": {
                    "mappingMode": "defineBelow",
                    "value": {
                        "snapshot_id": "={{$json.snapshot_id}}",
                        "timezone": "={{$json.timezone}}",
                        "odoo_base_url": "={{$json.odoo_base_url}}",
                        "odoo_db": "={{$json.odoo_db}}",
                        "odoo_username": "={{$json.odoo_username}}",
                        "odoo_api_key_or_password": "={{$json.odoo_api_key_or_password}}",
                        "target_company_id": "={{$json.target_company_id}}",
                        "target_company_name": "={{$json.target_company_name}}",
                        "company_context_ids": "={{$json.company_context_ids}}",
                        "date_start": "={{$json.date_start}}",
                        "date_end": "={{$json.date_end}}",
                        "output_root": "={{$json.output_root}}",
                        "page_limit": "={{$json.page_limit}}",
                        "max_anomaly_evidence_rows": "={{$json.max_anomaly_evidence_rows}}",
                        "max_claude_evidence_rows": "={{$json.max_claude_evidence_rows}}",
                    },
                    "matchingColumns": [],
                    "schema": [],
                    "attemptToConvertTypes": False,
                    "convertFieldsToString": False,
                },
                "options": {"waitForSubWorkflow": True},
            },
            "id": run02_id,
            "name": "Run 02 Sub - POS Retail",
            "type": "n8n-nodes-base.executeWorkflow",
            "typeVersion": 1.3,
            "position": [-16, -224],
        })

        # Rewire: Run 01 -> Run 02 -> Return Core Result
        connections["Run 01 Sub - Account Ledger"] = {
            "main": [[{"node": "Run 02 Sub - POS Retail", "type": "main", "index": 0}]],
        }
        connections["Run 02 Sub - POS Retail"] = {
            "main": [[{"node": "Return Core Result", "type": "main", "index": 0}]],
        }
        # Update Return Core Result position
        for n in nodes:
            if n.get("name") == "Run 01 Sub - Account Ledger":
                n["position"] = [-208, -224]
            if n.get("name") == "Return Core Result":
                n["position"] = [208, -224]
                n["parameters"]["jsCode"] = (
                    "const ledger = $('Run 01 Sub - Account Ledger').first().json;\n"
                    "const pos = $input.first().json;\n"
                    "return [{\n"
                    "  json: {\n"
                    "    snapshot_id: pos.snapshot_id || ledger.snapshot_id,\n"
                    "    stage_01_account_ledger: ledger,\n"
                    "    stage_02_pos_retail: pos,\n"
                    "    core_completed_at: new Date().toISOString(),\n"
                    "    next_stage: 'sanitise_profile_or_stage_03',\n"
                    "  },\n"
                    "}];\n"
                )
    else:
        for n in nodes:
            if n.get("name") == "Run 02 Sub - POS Retail":
                n["parameters"]["workflowId"]["value"] = wf_id

    nodes_sql = json.dumps(nodes).replace("'", "''")
    conn_sql = json.dumps(connections).replace("'", "''")
    subprocess.run(
        [
            "docker", "exec", "ghoststack-rag-n8n-db-1",
            "psql", "-U", "n8n", "-d", "n8n", "-c",
            f"UPDATE workflow_entity SET nodes = '{nodes_sql}'::json, connections = '{conn_sql}'::json WHERE id = '{parent_id}';",
        ],
        check=True,
    )
    print(f"Updated parent workflow {parent_id}")
    print("Done. Run 00_START_HERE_SINGLE_LEDGER_CLEAN in n8n.")


if __name__ == "__main__":
    main()
