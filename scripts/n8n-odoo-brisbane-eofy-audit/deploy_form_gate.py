#!/usr/bin/env python3
"""
Deploy a simple Form Trigger + Qwen LLM hub to 00_START_HERE_SINGLE_LEDGER_CLEAN.

Replaces:
  - Manual Trigger (requires opening node editor to change dates)
  - Select Audit Period Set node (hardcoded dates)
  - Confirm Period — Wait (orphaned, blocks execution)
  - Validate And Preview Period (absorbed into form mapping)

Adds:
  - Form Trigger  : fill date range + business in a browser form, click Submit
  - Map Form Values: Code node that normalises form output → pipeline fields
  - Qwen/Ollama LLM Hub (optional, second trigger): type a query, Qwen extracts
    date range + company → same pipeline

Usage:
  python3 deploy_form_gate.py
  python3 deploy_form_gate.py --llm-hub   (also add the LLM webhook trigger)
  python3 deploy_form_gate.py --dry-run    (print SQL, don't execute)
"""

import argparse
import base64
import json
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REGISTRY_PATH = ROOT / "config/odoo-runtime.json"

def load_registry():
    if REGISTRY_PATH.exists():
        reg = json.loads(REGISTRY_PATH.read_text())
        return (
            reg.get("companies", []),
            reg.get("fy_presets", []),
            reg.get("databases", []),
            reg.get("pipeline_defaults", {}),
            {
                "odoo_base_url": reg.get("odoo_base_url", ""),
                "odoo_username": reg.get("odoo_username", ""),
                "odoo_api_key_or_password": reg.get("odoo_api_key_or_password", ""),
            },
        )
    return None

_reg = load_registry()
if _reg:
    COMPANY_OPTIONS, FY_PRESETS, DATABASE_OPTIONS, PIPELINE_DEFAULTS, ODOO_CONN = _reg
else:
    COMPANY_OPTIONS = [
        {"label": "Ride Electric Southport",  "id": 3,  "timezone": "Australia/Sydney"},
        {"label": "Ride Electric Brisbane",   "id": 4,  "timezone": "Australia/Brisbane"},
        {"label": "Ride Electric Burleigh",   "id": 5,  "timezone": "Australia/Brisbane"},
        {"label": "Ride Electric Adelaide",   "id": 6,  "timezone": "Australia/Adelaide"},
    ]
    DATABASE_OPTIONS = [
        {"label": "RE-dev-2026-06-11 (current dev)", "odoo_db": "RE-dev-2026-06-11"},
    ]
    FY_PRESETS = [
        {"label": "FY 2024-25 (1 Jul 2024 – 30 Jun 2025)", "start": "2024-07-01", "end": "2025-06-30"},
        {"label": "FY 2023-24 (1 Jul 2023 – 30 Jun 2024)", "start": "2023-07-01", "end": "2024-06-30"},
        {"label": "FY 2022-23 (1 Jul 2022 – 30 Jun 2023)", "start": "2022-07-01", "end": "2023-06-30"},
        {"label": "Custom — use Date From / Date To below",  "start": "",            "end": ""},
    ]
    PIPELINE_DEFAULTS = {}
    ODOO_CONN = {}

PARENT_ID = "jYFaI5YUWM8KhwTY"

# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def sql_run(query: str, capture=True) -> str:
    result = subprocess.run(
        ["docker", "exec", "ghoststack-rag-n8n-db-1",
         "psql", "-U", "n8n", "-d", "n8n", "-t", "-A", "-c", query],
        check=True, text=True, capture_output=capture,
    )
    return result.stdout.strip() if capture else ""


def b64_json(value) -> str:
    payload = base64.b64encode(json.dumps(value).encode()).decode("ascii")
    return f"convert_from(decode('{payload}', 'base64'), 'utf8')::jsonb"


def load_workflow():
    raw_nodes = sql_run(f"SELECT nodes::text FROM workflow_entity WHERE id = '{PARENT_ID}';")
    raw_conn  = sql_run(f"SELECT connections::text FROM workflow_entity WHERE id = '{PARENT_ID}';")
    return json.loads(raw_nodes), json.loads(raw_conn)


def save_workflow(nodes, connections, dry_run=False):
    nodes_b64 = b64_json(nodes)
    conn_b64  = b64_json(connections)
    query = (
        f"UPDATE workflow_entity "
        f"SET nodes = {nodes_b64}, connections = {conn_b64} "
        f"WHERE id = '{PARENT_ID}';"
    )
    if dry_run:
        print("-- DRY RUN: would execute:")
        print(query[:400], "...")
    else:
        sql_run(query, capture=False)
        print(f"✓ Workflow {PARENT_ID} updated.")


# ---------------------------------------------------------------------------
# Node builders
# ---------------------------------------------------------------------------

def make_form_trigger(pos_x: int, pos_y: int) -> dict:
    """n8n Form Trigger — renders a browser form, no editing of nodes needed."""
    db_opts = [{"option": d["label"]} for d in DATABASE_OPTIONS]
    company_opts = [{"option": c["label"]} for c in COMPANY_OPTIONS]
    fy_opts      = [{"option": p["label"]} for p in FY_PRESETS]
    return {
        "id": "form-trigger-simple-gate",
        "name": "Start Audit Run",
        "type": "n8n-nodes-base.formTrigger",
        "typeVersion": 2.2,
        "position": [pos_x, pos_y],
        "webhookId": str(uuid.uuid4()),
        "parameters": {
            "formTitle": "Odoo Audit Run",
            "formDescription": "Pick Odoo database, business, and period, then click Submit to start extraction.",
            "formFields": {
                "values": [
                    {
                        "fieldLabel": "Odoo Database",
                        "fieldType": "dropdown",
                        "fieldOptions": {"values": db_opts},
                        "requiredField": True,
                        "defaultValue": db_opts[0]["option"] if db_opts else "",
                    },
                    {
                        "fieldLabel": "Business",
                        "fieldType": "dropdown",
                        "fieldOptions": {"values": company_opts},
                        "requiredField": True,
                    },
                    {
                        "fieldLabel": "Financial Year",
                        "fieldType": "dropdown",
                        "fieldOptions": {"values": fy_opts},
                        "requiredField": True,
                        "defaultValue": fy_opts[0]["option"],
                    },
                    {
                        "fieldLabel": "Date From",
                        "fieldType": "date",
                        "requiredField": False,
                        "placeholder": "Only if Custom period selected above",
                    },
                    {
                        "fieldLabel": "Date To",
                        "fieldType": "date",
                        "requiredField": False,
                        "placeholder": "Only if Custom period selected above",
                    },
                ]
            },
            "responseMode": "lastNode",
            "options": {},
        },
        "credentials": {},
    }


def make_map_form_node(pos_x: int, pos_y: int) -> dict:
    """Code node: normalises Form Trigger output → pipeline fields."""
    company_map = {c["label"]: {"id": c["id"], "timezone": c["timezone"]} for c in COMPANY_OPTIONS}
    db_map = {d["label"]: d["odoo_db"] for d in DATABASE_OPTIONS}
    fy_map = {p["label"]: {"start": p["start"], "end": p["end"]} for p in FY_PRESETS}
    static_cfg = {**ODOO_CONN, **PIPELINE_DEFAULTS}

    code = f"""// Map Form Trigger values -> complete pipeline config
const staticCfg = {json.dumps(static_cfg)};
const companyMap = {json.dumps(company_map)};
const dbMap = {json.dumps(db_map)};
const fyMap = {json.dumps(fy_map)};

const input = $input.first().json;

const dbLabel = String(input['Odoo Database'] || '').trim();
const companyLabel = String(input['Business'] || '').trim();
const fyLabel      = String(input['Financial Year'] || '').trim();
const customStart  = String(input['Date From'] || '').trim();
const customEnd    = String(input['Date To']   || '').trim();

if (!dbMap[dbLabel]) {{
  throw new Error('Unknown Odoo database: ' + dbLabel + '. Options: ' + Object.keys(dbMap).join(', '));
}}
if (!companyMap[companyLabel]) {{
  throw new Error('Unknown business: ' + companyLabel + '. Options: ' + Object.keys(companyMap).join(', '));
}}
const company = companyMap[companyLabel];
const odooDb = dbMap[dbLabel];

let dateStart, dateEnd;
if (fyLabel.startsWith('Custom')) {{
  dateStart = customStart;
  dateEnd   = customEnd;
  if (!dateStart || !dateEnd) {{
    throw new Error('Custom period selected but Date From / Date To are empty.');
  }}
}} else {{
  const fy = fyMap[fyLabel];
  if (!fy) throw new Error('Unknown FY preset: ' + fyLabel);
  dateStart = fy.start;
  dateEnd   = fy.end;
}}

const isoRe = /^\\d{{4}}-\\d{{2}}-\\d{{2}}$/;
if (!isoRe.test(dateStart) || !isoRe.test(dateEnd)) {{
  throw new Error('Dates must be YYYY-MM-DD. Got: ' + dateStart + ' / ' + dateEnd);
}}
if (dateStart >= dateEnd) {{
  throw new Error('Date From must be before Date To.');
}}

return [{{ json: {{
  ...staticCfg,
  odoo_db: odooDb,
  target_company_id:   company.id,
  target_company_name: companyLabel,
  company_context_ids: company.id,
  timezone:            company.timezone,
  date_start:          dateStart,
  date_end:            dateEnd,
  period_label:        fyLabel.startsWith('Custom') ? dateStart + ' to ' + dateEnd : fyLabel,
  snapshot_id:         '',
  odoo_database_label: dbLabel,
}} }}];
"""
    return {
        "id": "map-form-values",
        "name": "Map Form Values",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [pos_x, pos_y],
        "parameters": {"jsCode": code, "mode": "runOnceForAllItems"},
    }


def make_llm_webhook_trigger(pos_x: int, pos_y: int) -> dict:
    """Webhook trigger that accepts a JSON body with a 'query' field."""
    return {
        "id": "llm-hub-webhook",
        "name": "LLM Hub — Webhook",
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2,
        "position": [pos_x, pos_y],
        "webhookId": str(uuid.uuid4()),
        "parameters": {
            "path": "eofy-audit-llm",
            "httpMethod": "POST",
            "responseMode": "lastNode",
            "options": {},
        },
    }


def make_llm_extract_node(pos_x: int, pos_y: int, ollama_cred_id: str) -> dict:
    """Ollama/Qwen node: extract date_start, date_end, target_company_name from free text."""
    company_list = ", ".join(c["label"] for c in COMPANY_OPTIONS)
    prompt = (
        f"Extract audit parameters from the user's query. "
        f"Available companies: {company_list}. "
        f"Return ONLY valid JSON with keys: company_name (string), date_start (YYYY-MM-DD), date_end (YYYY-MM-DD). "
        f"If the year is ambiguous assume the most recent completed financial year (FY ending 30 Jun 2025). "
        f"If the company is ambiguous default to Ride Electric Brisbane."
    )
    return {
        "id": "llm-extract-params",
        "name": "Qwen — Extract Audit Params",
        "type": "@n8n/n8n-nodes-langchain.lmChatOllama",
        "typeVersion": 1,
        "position": [pos_x, pos_y],
        "parameters": {
            "model": "qwen2.5:latest",
            "options": {"temperature": 0},
            "messages": {
                "values": [
                    {"type": "system", "message": prompt},
                    {"type": "user",   "message": "={{ $json.body.query }}"},
                ]
            },
        },
        "credentials": {
            "ollamaApi": {"id": ollama_cred_id, "name": "Ollama account"},
        },
    }


def make_llm_map_node(pos_x: int, pos_y: int) -> dict:
    """Code node: parse Qwen JSON output → same pipeline fields as form mapper."""
    company_map = {c["label"]: {"id": c["id"], "timezone": c["timezone"]} for c in COMPANY_OPTIONS}
    code = f"""// Parse Qwen JSON output and map to pipeline fields
const companyMap = {json.dumps(company_map)};
const raw = $input.first().json;

let parsed;
try {{
  // Qwen may wrap in ```json ... ``` fences
  const text = (raw.text || raw.message || raw.response || JSON.stringify(raw)).replace(/```json|```/g, '').trim();
  parsed = JSON.parse(text);
}} catch (e) {{
  throw new Error('Qwen did not return valid JSON: ' + e.message);
}}

const companyLabel = String(parsed.company_name || 'Ride Electric Brisbane').trim();
const dateStart    = String(parsed.date_start || '').trim();
const dateEnd      = String(parsed.date_end   || '').trim();

if (!companyMap[companyLabel]) {{
  throw new Error('Unknown company from Qwen: ' + companyLabel);
}}
const company = companyMap[companyLabel];

return [{{ json: {{
  target_company_id:   company.id,
  target_company_name: companyLabel,
  company_context_ids: company.id,
  timezone:            company.timezone,
  date_start:          dateStart,
  date_end:            dateEnd,
  period_label:        dateStart + ' to ' + dateEnd,
  snapshot_id:         '',
}} }}];
"""
    return {
        "id": "llm-map-params",
        "name": "Map LLM Params",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [pos_x, pos_y],
        "parameters": {"jsCode": code, "mode": "runOnceForAllItems"},
    }


# ---------------------------------------------------------------------------
# Main patcher
# ---------------------------------------------------------------------------

NODES_TO_REMOVE = {
    "Manual Trigger",
    "Select Audit Period",
    "Validate And Preview Period",
    "Confirm Period — Wait",
    "README - Period Gate",
    "README - Period Gate1",
}

# Update Core Run Config to merge incoming date/company fields (form or LLM)
CORE_RUN_FIELDS_TO_REMOVE = {"date_start", "date_end", "target_company_id",
                              "target_company_name", "company_context_ids", "timezone"}


def patch_core_run_config(node: dict) -> dict:
    """Remove date/company fields from Core Run Config — these now come from form.
    Also enable includeOtherFields so the Set node passes through form values."""
    assignments = node["parameters"]["assignments"]["assignments"]
    node["parameters"]["assignments"]["assignments"] = [
        a for a in assignments if a["name"] not in CORE_RUN_FIELDS_TO_REMOVE
    ]
    # Critical: without this, Set node drops all incoming fields (date_start etc. get lost)
    node["parameters"]["options"]["includeOtherFields"] = True
    return node


def merge_form_into_core_node(pos_x: int, pos_y: int) -> dict:
    """Merge node: combine Form/LLM values with Core Run Config."""
    return {
        "id": "merge-inputs",
        "name": "Merge Gate + Config",
        "type": "n8n-nodes-base.merge",
        "typeVersion": 3,
        "position": [pos_x, pos_y],
        "parameters": {
            "mode": "combine",
            "combinationMode": "mergeByPosition",
            "options": {},
        },
    }


def patch(add_llm_hub=False, dry_run=False):
    nodes, connections = load_workflow()

    # Find Core Run Config position for layout reference
    core_node = next((n for n in nodes if n.get("name") == "Core Run Config"), None)
    if not core_node:
        raise RuntimeError("Core Run Config node not found in workflow.")
    cx, cy = core_node["position"]

    # --- Remove old trigger and period nodes ---
    nodes = [n for n in nodes if n.get("name") not in NODES_TO_REMOVE]

    # --- Patch Core Run Config ---
    for i, n in enumerate(nodes):
        if n.get("name") == "Core Run Config":
            nodes[i] = patch_core_run_config(n)
            nodes[i]["position"] = [cx, cy + 200]  # move down to make room
            break

    # --- Build new nodes ---
    form_trigger = make_form_trigger(cx - 500, cy)
    map_form     = make_map_form_node(cx - 200, cy)
    nodes.extend([form_trigger, map_form])

    if add_llm_hub:
        # Find Ollama credential ID
        cred_raw = sql_run("SELECT id FROM credentials_entity WHERE name = 'Ollama account' LIMIT 1;")
        ollama_cred_id = cred_raw or "ollama-account"
        llm_webhook = make_llm_webhook_trigger(cx - 500, cy + 400)
        llm_extract  = make_llm_extract_node(cx - 200, cy + 400, ollama_cred_id)
        llm_map      = make_llm_map_node(cx + 100, cy + 400)
        nodes.extend([llm_webhook, llm_extract, llm_map])

    # --- Rebuild connections ---
    # Remove old trigger connections
    for dead in NODES_TO_REMOVE:
        connections.pop(dead, None)

    # Form path: bypass Set nodes (they drop incoming fields) — go direct to Build Snapshot Context
    connections["Start Audit Run"] = {"main": [[{"node": "Map Form Values", "type": "main", "index": 0}]]}
    connections["Map Form Values"] = {"main": [[{"node": "Build Snapshot Context", "type": "main", "index": 0}]]}

    if add_llm_hub:
        connections["LLM Hub — Webhook"]           = {"main": [[{"node": "Qwen — Extract Audit Params", "type": "main", "index": 0}]]}
        connections["Qwen — Extract Audit Params"] = {"main": [[{"node": "Map LLM Params", "type": "main", "index": 0}]]}
        connections["Map LLM Params"]              = {"main": [[{"node": "Build Snapshot Context", "type": "main", "index": 0}]]}

    # Manual path keeps Core Run Config → Select Audit Period → Validate → Build Snapshot Context
    for n in nodes:
        if n.get("name") == "Core Run Config":
            existing = {a["name"] for a in n["parameters"]["assignments"]["assignments"]}
            for d in [
                {"id": "target_company_id", "name": "target_company_id", "type": "number", "value": 4},
                {"id": "target_company_name", "name": "target_company_name", "type": "string", "value": "Ride Electric Brisbane"},
                {"id": "company_context_ids", "name": "company_context_ids", "type": "number", "value": 4},
                {"id": "timezone", "name": "timezone", "type": "string", "value": "Australia/Brisbane"},
            ]:
                if d["name"] not in existing:
                    n["parameters"]["assignments"]["assignments"].append(d)
        elif n.get("name") == "Select Audit Period":
            n["parameters"].setdefault("options", {})["includeOtherFields"] = True

    save_workflow(nodes, connections, dry_run=dry_run)
    print()
    print("Workflow updated. Changes made:")
    print("  ✓ Removed: Manual Trigger, Select Audit Period, Validate And Preview Period, Confirm Period — Wait")
    print("  ✓ Added:   Start Audit Run (Form Trigger) — browser form with date picker + business dropdown")
    print("  ✓ Added:   Map Form Values — normalises form output to pipeline fields")
    print("  ✓ Cleaned: Core Run Config — date/company fields now come from form (not hardcoded)")
    if add_llm_hub:
        print("  ✓ Added:   LLM Hub — Webhook  (POST /webhook/eofy-audit-llm with body {\"query\":\"...\"})")
        print("  ✓ Added:   Qwen — Extract Audit Params (Ollama)")
        print("  ✓ Added:   Map LLM Params")
    print()
    print("Next steps:")
    print("  1. Refresh n8n at https://workflow.rideai.com.au")
    print("  2. Open workflow 00_START_HERE_SINGLE_LEDGER_CLEAN")
    print("  3. Activate the workflow (toggle in top-right)")
    print("  4. Click the form URL shown on Start Audit Run node to open the form")
    print("  5. Fill in business + period, click Submit — workflow starts automatically")
    if add_llm_hub:
        print("  6. Or POST to <n8n>/webhook/eofy-audit-llm with body {\"query\":\"Run Brisbane EOFY 2024-25\"}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Deploy Form Trigger gate to EOFY orchestrator.")
    parser.add_argument("--llm-hub",  action="store_true", help="Also add Qwen/Ollama LLM webhook trigger")
    parser.add_argument("--dry-run",  action="store_true", help="Print SQL but do not execute")
    args = parser.parse_args()
    patch(add_llm_hub=args.llm_hub, dry_run=args.dry_run)
