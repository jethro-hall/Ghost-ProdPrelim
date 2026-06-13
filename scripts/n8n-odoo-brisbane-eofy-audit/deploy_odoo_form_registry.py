#!/usr/bin/env python3
"""Patch orchestrator form: Odoo database dropdown + company/db from config registry."""

import base64
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REGISTRY = json.loads((ROOT / "config/odoo-runtime.json").read_text())
PARENT_ID = "jYFaI5YUWM8KhwTY"

COMPANIES = REGISTRY["companies"]
DATABASES = REGISTRY["databases"]
FY_PRESETS = REGISTRY["fy_presets"]
PIPELINE = REGISTRY["pipeline_defaults"]
ODOO_CONN = {
    "odoo_base_url": REGISTRY["odoo_base_url"],
    "odoo_username": REGISTRY["odoo_username"],
    "odoo_api_key_or_password": REGISTRY["odoo_api_key_or_password"],
}


def sql_run(query: str, capture=True) -> str:
    r = subprocess.run(
        ["docker", "exec", "ghoststack-rag-n8n-db-1",
         "psql", "-U", "n8n", "-d", "n8n", "-t", "-A", "-c", query],
        check=True, text=True, capture_output=capture,
    )
    return r.stdout.strip() if capture else ""


def b64_json(value) -> str:
    payload = base64.b64encode(json.dumps(value).encode()).decode("ascii")
    return f"convert_from(decode('{payload}', 'base64'), 'utf8')::jsonb"


def build_map_form_code() -> str:
    company_map = {c["label"]: {"id": c["id"], "timezone": c["timezone"]} for c in COMPANIES}
    db_map = {d["label"]: d["odoo_db"] for d in DATABASES}
    fy_map = {p["label"]: {"start": p["start"], "end": p["end"]} for p in FY_PRESETS}
    static_cfg = {**ODOO_CONN, **PIPELINE}

    return f"""// Map Form Trigger values -> complete pipeline config (from config/odoo-runtime.json)
const staticCfg = {json.dumps(static_cfg)};
const companyMap = {json.dumps(company_map)};
const dbMap = {json.dumps(db_map)};
const fyMap = {json.dumps(fy_map)};

const input = $input.first().json;

const dbLabel = String(input['Odoo Database'] || '').trim();
const companyLabel = String(input['Business'] || '').trim();
const fyLabel = String(input['Financial Year'] || '').trim();
const customStart = String(input['Date From'] || '').trim();
const customEnd = String(input['Date To'] || '').trim();

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
  dateEnd = customEnd;
  if (!dateStart || !dateEnd) throw new Error('Custom period selected but Date From / Date To are empty.');
}} else {{
  const fy = fyMap[fyLabel];
  if (!fy) throw new Error('Unknown FY preset: ' + fyLabel);
  dateStart = fy.start;
  dateEnd = fy.end;
}}

const isoRe = /^\\d{{4}}-\\d{{2}}-\\d{{2}}$/;
if (!isoRe.test(dateStart) || !isoRe.test(dateEnd)) {{
  throw new Error('Dates must be YYYY-MM-DD. Got: ' + dateStart + ' / ' + dateEnd);
}}
if (dateStart >= dateEnd) throw new Error('Date From must be before Date To.');

return [{{ json: {{
  ...staticCfg,
  odoo_db: odooDb,
  target_company_id: company.id,
  target_company_name: companyLabel,
  company_context_ids: company.id,
  timezone: company.timezone,
  date_start: dateStart,
  date_end: dateEnd,
  period_label: fyLabel.startsWith('Custom') ? dateStart + ' to ' + dateEnd : fyLabel,
  snapshot_id: '',
  odoo_database_label: dbLabel,
}} }}];
"""


def patch_form_trigger(node: dict) -> dict:
    db_opts = [{"option": d["label"]} for d in DATABASES]
    company_opts = [{"option": c["label"]} for c in COMPANIES]
    fy_opts = [{"option": p["label"]} for p in FY_PRESETS]

    node["parameters"]["formDescription"] = (
        "Pick Odoo database, business, and financial year, then Submit to start extraction."
    )
    node["parameters"]["formFields"] = {
        "values": [
            {
                "fieldLabel": "Odoo Database",
                "fieldType": "dropdown",
                "fieldOptions": {"values": db_opts},
                "requiredField": True,
                "defaultValue": db_opts[0]["option"],
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
            },
            {
                "fieldLabel": "Date To",
                "fieldType": "date",
                "requiredField": False,
            },
        ]
    }
    return node


def strip_odoo_from_core_config(node: dict) -> dict:
    """Core Run Config is legacy/manual only — do not hardcode db or company."""
    drop = {
        "odoo_base_url", "odoo_db", "odoo_username", "odoo_api_key_or_password",
        "target_company_id", "target_company_name", "company_context_ids", "timezone",
        "date_start", "date_end",
    }
    node["parameters"]["assignments"]["assignments"] = [
        a for a in node["parameters"]["assignments"]["assignments"]
        if a["name"] not in drop
    ]
    return node


def main():
    nodes = json.loads(sql_run(f"SELECT nodes::text FROM workflow_entity WHERE id='{PARENT_ID}';"))
    conn = json.loads(sql_run(f"SELECT connections::text FROM workflow_entity WHERE id='{PARENT_ID}';"))

    map_code = build_map_form_code()
    updated = []
    for i, n in enumerate(nodes):
        name = n.get("name")
        if name == "Start Audit Run":
            nodes[i] = patch_form_trigger(n)
            updated.append("Start Audit Run (Odoo Database dropdown)")
        elif name == "Map Form Values":
            n["parameters"]["jsCode"] = map_code
            updated.append("Map Form Values (db + company from form)")
        elif name == "Core Run Config":
            nodes[i] = strip_odoo_from_core_config(n)
            updated.append("Core Run Config (removed hardcoded odoo/db/company)")

    # Ensure form path bypasses Set nodes
    conn["Map Form Values"] = {"main": [[{"node": "Build Snapshot Context", "type": "main", "index": 0}]]}

    sql_run(
        f"UPDATE workflow_entity SET nodes={b64_json(nodes)}, connections={b64_json(conn)} "
        f"WHERE id='{PARENT_ID}';",
        capture=False,
    )

    print("✓ Workflow updated:")
    for line in updated:
        print(f"  - {line}")
    print("\nForm fields: Odoo Database → Business → Financial Year → (optional custom dates)")
    print(f"Default database: {DATABASES[0]['odoo_db']}")
    print("Companies:", ", ".join(c["label"] for c in COMPANIES))


if __name__ == "__main__":
    main()
