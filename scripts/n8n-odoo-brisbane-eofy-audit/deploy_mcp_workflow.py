#!/usr/bin/env python3
"""
Deploy Odoo EOFY Forensic MCP workflow to n8n (v2.16+ compatible).

Creates/updates workflow_entity, workflow_history, workflow_published_version,
webhook_entity, and shared_workflow to fully activate the webhook.

Usage:
  python3 deploy_mcp_workflow.py
"""

import base64
import json
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WF_ID = "ZEOFY_MCP_v3"
WF_NAME = "EOFY MCP Forensic Audit v3"
PROJECT_ID = "PTLdxNJsT8UqtX3i"
WEBHOOK_ID = "odoo-eofy-forensic-mcp-v3"
WEBHOOK_PATH = "odoo-eofy-forensic-mcp-v3"
DB_CONTAINER = "ghoststack-rag-n8n-db-1"
N8N_CONTAINER = "ghoststack-rag-n8n-1"

MCP_CODE = (ROOT / "lib/mcp_server.js").read_text()


# ── SQL helpers ───────────────────────────────────────────────────────────────

def sql_b64(obj) -> str:
    """Encode an object as base64 JSON literal for safe psql injection."""
    payload = base64.b64encode(json.dumps(obj).encode()).decode()
    return f"convert_from(decode('{payload}', 'base64'), 'utf8')::json"


def sql_str(obj) -> str:
    """Encode an object as base64 text literal."""
    payload = base64.b64encode(json.dumps(obj).encode()).decode()
    return f"convert_from(decode('{payload}', 'base64'), 'utf8')"


def run_sql(stmt: str) -> str:
    return subprocess.check_output(
        ["docker", "exec", DB_CONTAINER,
         "psql", "-U", "n8n", "-d", "n8n", "-t", "-A", "-c", stmt],
        text=True,
    ).strip()


def run_sql_cmd(stmt: str):
    r = subprocess.run(
        ["docker", "exec", DB_CONTAINER,
         "psql", "-U", "n8n", "-d", "n8n", "-c", stmt],
        check=True, text=True, capture_output=True,
    )
    if r.stdout.strip():
        print(r.stdout.strip())
    return r


# ── Workflow payload ──────────────────────────────────────────────────────────

NODES = [
    {
        "parameters": {
            "httpMethod": "POST",
            "path": WEBHOOK_PATH,
            "responseMode": "responseNode",
            "options": {},
        },
        "id": "mcp-webhook",
        "name": "MCP Webhook - Odoo EOFY",
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2,
        "position": [-640, 256],
        "webhookId": WEBHOOK_ID,
    },
    {
        "parameters": {"jsCode": MCP_CODE},
        "id": "mcp-code",
        "name": "Serve Odoo EOFY MCP v3",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [-352, 256],
    },
    {
        "parameters": {
            "respondWith": "json",
            "responseBody": "={{$json}}",
            "options": {},
        },
        "id": "mcp-respond",
        "name": "Respond MCP JSON",
        "type": "n8n-nodes-base.respondToWebhook",
        "typeVersion": 1.1,
        "position": [-80, 256],
    },
]

CONNECTIONS = {
    "MCP Webhook - Odoo EOFY": {
        "main": [[{"node": "Serve Odoo EOFY MCP v3", "type": "main", "index": 0}]]
    },
    "Serve Odoo EOFY MCP v3": {
        "main": [[{"node": "Respond MCP JSON", "type": "main", "index": 0}]]
    },
}

SETTINGS = {"executionOrder": "v1"}
META = {"instanceId": "n8n-eofy-mcp-v3"}


# ── Deploy steps ──────────────────────────────────────────────────────────────

def get_user_id() -> str:
    return run_sql("SELECT id FROM \"user\" LIMIT 1;")


def upsert_workflow_entity(version_id: str):
    exists = run_sql(f"SELECT 1 FROM workflow_entity WHERE id='{WF_ID}';")
    safe_name = WF_NAME.replace("'", "''")

    if exists:
        print(f"Updating workflow_entity {WF_ID}")
        run_sql_cmd(
            f"UPDATE workflow_entity SET "
            f"name='{safe_name}', "
            f"active=true, "
            f"nodes={sql_b64(NODES)}, "
            f"connections={sql_b64(CONNECTIONS)}, "
            f"settings={sql_b64(SETTINGS)}, "
            f"meta={sql_b64(META)}, "
            f'"versionId"=\'{version_id}\', '
            f'"updatedAt"=NOW() '
            f"WHERE id='{WF_ID}';"
        )
    else:
        print(f"Inserting workflow_entity {WF_ID}")
        run_sql_cmd(
            f"INSERT INTO workflow_entity "
            f"(id, name, active, nodes, connections, settings, meta, "
            f'"versionId", "triggerCount", "isArchived", "versionCounter") '
            f"VALUES ("
            f"'{WF_ID}', '{safe_name}', true, "
            f"{sql_b64(NODES)}, "
            f"{sql_b64(CONNECTIONS)}, "
            f"{sql_b64(SETTINGS)}, "
            f"{sql_b64(META)}, "
            f"'{version_id}', 0, false, 1);"
        )


def upsert_shared_workflow(project_id: str):
    run_sql_cmd(
        f"INSERT INTO shared_workflow (\"workflowId\", \"projectId\", role) "
        f"VALUES ('{WF_ID}', '{project_id}', 'workflow:owner') "
        f"ON CONFLICT DO NOTHING;"
    )
    print(f"Shared workflow with project {project_id}")


def upsert_workflow_history(version_id: str, user_email: str):
    """Create/update a workflow_history entry for the active version."""
    exists = run_sql(f"SELECT 1 FROM workflow_history WHERE \"versionId\"='{version_id}';")
    if exists:
        print(f"workflow_history {version_id} already exists — skipping")
        return
    print(f"Inserting workflow_history {version_id}")
    run_sql_cmd(
        f"INSERT INTO workflow_history "
        f"(\"versionId\", \"workflowId\", authors, nodes, connections, name, autosaved) "
        f"VALUES ("
        f"'{version_id}', '{WF_ID}', '{user_email}', "
        f"{sql_b64(NODES)}, "
        f"{sql_b64(CONNECTIONS)}, "
        f"'{WF_NAME.replace(chr(39), chr(39)*2)}', "
        f"false);"
    )


def set_active_version_id(version_id: str):
    """Link workflow_entity.activeVersionId to workflow_history."""
    print(f"Setting activeVersionId={version_id} on workflow {WF_ID}")
    run_sql_cmd(
        f"UPDATE workflow_entity SET "
        f'"activeVersionId"=\'{version_id}\' '
        f"WHERE id='{WF_ID}';"
    )


def upsert_published_version(version_id: str):
    """Insert/update workflow_published_version so n8n can activate it."""
    exists = run_sql(f"SELECT 1 FROM workflow_published_version WHERE \"workflowId\"='{WF_ID}';")
    if exists:
        print(f"Updating workflow_published_version {WF_ID}")
        run_sql_cmd(
            f"UPDATE workflow_published_version SET "
            f"\"publishedVersionId\"='{version_id}', \"updatedAt\"=NOW() "
            f"WHERE \"workflowId\"='{WF_ID}';"
        )
    else:
        print(f"Inserting workflow_published_version {WF_ID}")
        run_sql_cmd(
            f"INSERT INTO workflow_published_version (\"workflowId\", \"publishedVersionId\") "
            f"VALUES ('{WF_ID}', '{version_id}');"
        )


def upsert_webhook_entity():
    """Register the webhook path in webhook_entity."""
    # Remove any conflicting rows for this path/workflow
    run_sql_cmd(
        f"DELETE FROM webhook_entity WHERE \"webhookPath\"='{WEBHOOK_PATH}';"
    )
    run_sql_cmd(
        f"INSERT INTO webhook_entity (\"webhookPath\", method, node, \"webhookId\", \"pathLength\", \"workflowId\") "
        f"VALUES ('{WEBHOOK_PATH}', 'POST', 'MCP Webhook - Odoo EOFY', '{WEBHOOK_ID}', 1, '{WF_ID}');"
    )
    print(f"Registered webhook: POST /webhook/{WEBHOOK_PATH} -> {WF_ID}")


def verify():
    name = run_sql(f"SELECT name FROM workflow_entity WHERE id='{WF_ID}';")
    active = run_sql(f"SELECT active FROM workflow_entity WHERE id='{WF_ID}';")
    av = run_sql(f"SELECT \"activeVersionId\" FROM workflow_entity WHERE id='{WF_ID}';")
    pv = run_sql(f"SELECT \"publishedVersionId\" FROM workflow_published_version WHERE \"workflowId\"='{WF_ID}';")
    wh = run_sql(f"SELECT \"workflowId\" FROM webhook_entity WHERE \"webhookPath\"='{WEBHOOK_PATH}';")
    print(f"\nVerification:")
    print(f"  workflow_entity:          {WF_ID} = '{name}'  active={active}")
    print(f"  activeVersionId:          {av}")
    print(f"  publishedVersionId:       {pv}")
    print(f"  webhook_entity:           {WEBHOOK_PATH} -> {wh}")


def restart_n8n():
    print("\nRestarting n8n to load new webhook registration...")
    subprocess.run(
        ["docker", "compose", "-f",
         str(ROOT.parent.parent / "docker-compose.yml"),
         "restart", "n8n"],
        check=True,
    )
    import time
    print("Waiting 15s for n8n to start...")
    time.sleep(15)


def smoke_test():
    import time
    token = None
    try:
        line = (ROOT / "lib/mcp_server.js").read_text()
        import re
        m = re.search(r"ACCESS_TOKEN = '([^']+)'", line)
        if m:
            token = m.group(1)
    except Exception:
        pass

    if not token or token == "PUT_LONG_RANDOM_TOKEN_HERE":
        print("\nSkipping smoke test — ACCESS_TOKEN not set in mcp_server.js")
        return

    print("\nRunning smoke test: tools/list ...")
    result = subprocess.run(
        ["docker", "exec", N8N_CONTAINER,
         "node", "-e", f"""
const http = require('http');
const body = JSON.stringify({{jsonrpc:'2.0',id:1,method:'tools/list'}});
const opts = {{hostname:'localhost',port:5678,
  path:'/webhook/{WEBHOOK_PATH}',method:'POST',
  headers:{{'Content-Type':'application/json','Authorization':'Bearer {token}',
  'Content-Length':Buffer.byteLength(body)}}}};
const req = http.request(opts, res => {{
  let d=''; res.on('data',c=>d+=c);
  res.on('end',()=>{{
    try{{const r=JSON.parse(d); const t=(r.result||{{}}).tools||[];
    console.log('tools/list OK:', t.length, 'tools');
    t.slice(0,5).forEach(x=>console.log(' -',x.name));
    }}catch(e){{console.log('parse err:', d.slice(0,200));}}
  }});
}});
req.on('error', e=>console.error('req err:', e.message));
req.write(body); req.end();
"""],
        text=True, capture_output=True,
    )
    print(result.stdout.strip() or result.stderr.strip() or "(no output)")


def main():
    version_id = str(uuid.uuid4())
    user_email = run_sql("SELECT email FROM \"user\" LIMIT 1;") or "admin"

    print(f"Deploying {WF_NAME} (id: {WF_ID})")
    print(f"  version_id: {version_id}")
    print(f"  user: {user_email}")
    print()

    upsert_workflow_entity(version_id)
    upsert_shared_workflow(PROJECT_ID)
    upsert_workflow_history(version_id, user_email)
    set_active_version_id(version_id)
    upsert_published_version(version_id)
    upsert_webhook_entity()
    verify()
    restart_n8n()
    smoke_test()

    print()
    print(f"Webhook: POST https://workflow.rideai.com.au/webhook/{WEBHOOK_PATH}")
    print(f"Token:   see ACCESS_TOKEN in lib/mcp_server.js")
    print()
    print("Connect Claude Desktop MCP to this server:")
    print(f"  URL: https://workflow.rideai.com.au/webhook/{WEBHOOK_PATH}")
    print(f"  Header: Authorization: Bearer <token>")


if __name__ == "__main__":
    main()
