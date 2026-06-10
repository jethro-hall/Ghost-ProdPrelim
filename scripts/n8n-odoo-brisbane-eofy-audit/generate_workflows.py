#!/usr/bin/env python3
"""Generate importable n8n workflow JSON from lib/ and config/."""

from __future__ import annotations

import json
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "config"
LIB = ROOT / "lib"
OUT = ROOT / "workflows"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def node_id() -> str:
    return str(uuid.uuid4())


def sticky(content: str, x: int, y: int, w: int = 400, h: int = 200) -> dict:
    return {
        "parameters": {
            "content": content,
            "height": h,
            "width": w,
            "color": 4,
        },
        "id": node_id(),
        "name": f"Note: {content[:40]}",
        "type": "n8n-nodes-base.stickyNote",
        "position": [x, y],
        "typeVersion": 1,
    }


def build_extract_export_workflow() -> dict:
    scope = read_json(CONFIG / "audit-scope.json")
    registry = read_json(CONFIG / "model-registry.json")
    odoo_rpc = read_text(LIB / "odoo-rpc.js")

    export_code = f"""
const fs = require('fs');
const path = require('path');

{odoo_rpc}

const scope = {json.dumps(scope, indent=2)};
const registry = {json.dumps(registry, indent=2)};

const input = $input.first().json;
const snapshotId = input.snapshot_id || `eofy_brisbane_${{new Date().toISOString().replace(/[:.]/g, '-')}}`;
const sampleLimit = input.sample_limit ?? scope.export_defaults.sample_limit_per_model;
const batchSize = input.batch_size ?? scope.export_defaults.batch_size;
const rawRoot = scope.export_paths.raw_root;

if (!fs.existsSync(rawRoot)) fs.mkdirSync(rawRoot, {{ recursive: true }});

const credentials = await this.getCredentials('odooApi');
const auth = await odooAuthenticate(this, credentials);

const results = [];

for (const modelDef of registry.models) {{
  const exportKey = modelDef.export_key;
  const group = modelDef.group;
  const odooModel = modelDef.odoo_model;
  const fields = modelDef.fields;
  const domain = buildDomain(modelDef, scope);
  const baseName = exportFileBase(snapshotId, group, exportKey, 0);
  const jsonlPath = path.join(rawRoot, `${{baseName}}.jsonl`);
  const manifestPath = path.join(rawRoot, `${{baseName}}.manifest.json`);

  let manifest = {{
    snapshot_id: snapshotId,
    model: odooModel,
    export_key: exportKey,
    group,
    offset: 0,
    limit: batchSize,
    exported_rows: 0,
    source_company_context: [scope.company_id],
    sanitisation: scope.export_defaults.sanitise,
  }};

  try {{
    const total = await odooSearchCount(this, auth, odooModel, domain);
    manifest.search_count = total;
    const effectiveLimit = sampleLimit ? Math.min(sampleLimit, total) : total;
    let offset = 0;
    let written = 0;
    const lines = [];

    while (offset < effectiveLimit) {{
      const limit = Math.min(batchSize, effectiveLimit - offset);
      const rows = await odooSearchRead(
        this, auth, odooModel, domain, fields, offset, limit, scope.export_defaults.order
      );
      if (!rows.length) break;
      for (const row of rows) {{
        const flat = flattenMany2one(row);
        lines.push(JSON.stringify(flat));
        written += 1;
        if (flat.id) {{
          manifest.first_id = manifest.first_id ?? flat.id;
          manifest.last_id = flat.id;
        }}
      }}
      offset += rows.length;
      if (rows.length < limit) break;
    }}

    fs.writeFileSync(jsonlPath, lines.join('\\n') + (lines.length ? '\\n' : ''));
    manifest.status = written ? 'written' : 'empty';
    manifest.exported_rows = written;
    manifest.output_file_absolute = jsonlPath;
    manifest.manifest_file_absolute = manifestPath;
    manifest.exported_at = new Date().toISOString();
  }} catch (error) {{
    manifest.status = error.odoo ? 'odoo_error' : 'error';
    manifest.error = error.odoo || {{ message: error.message }};
    manifest.exported_at = new Date().toISOString();
    manifest.output_file_absolute = jsonlPath;
    manifest.manifest_file_absolute = manifestPath;
    fs.writeFileSync(jsonlPath, '');
  }}

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  results.push(manifest);
}}

return [{{
  json: {{
    ok: true,
    snapshot_id: snapshotId,
    raw_root: rawRoot,
    models_exported: results.length,
    written: results.filter(r => r.status === 'written').length,
    errors: results.filter(r => r.status !== 'written' && r.status !== 'empty').length,
    manifests: results,
  }}
}}];
"""

    init_code = """
const scope = """ + json.dumps(read_json(CONFIG / "audit-scope.json")) + """;
const snapshotId = `eofy_brisbane_${new Date().toISOString().replace(/[:.]/g, '-')}`;
return [{
  json: {
    snapshot_id: snapshotId,
    sample_limit: null,
    batch_size: scope.export_defaults.batch_size,
    company_id: scope.company_id,
    fy_start: scope.financial_year_start,
    fy_end: scope.financial_year_end,
  }
}];
"""

    nodes = [
        {
            "parameters": {},
            "id": node_id(),
            "name": "Manual: Start Brisbane EOFY Extract",
            "type": "n8n-nodes-base.manualTrigger",
            "position": [240, 400],
            "typeVersion": 1,
        },
        sticky(
            "## Ride Electric Brisbane EOFY — Odoo Extract\n"
            "1. Attach Odoo API credential (needs read access; POS models need POS/Inventory group).\n"
            "2. Run manually. Exports to `/home/node/.n8n/odoo_eofy_exports`.\n"
            "3. Then run workflow 02 sanitise/profile.\n"
            "Scope: company_id=4, FY 2024-07-01 to 2025-06-30.",
            200,
            160,
            520,
            220,
        ),
        {
            "parameters": {"jsCode": init_code},
            "id": node_id(),
            "name": "Init snapshot + scope",
            "type": "n8n-nodes-base.code",
            "position": [480, 400],
            "typeVersion": 2,
        },
        {
            "parameters": {"jsCode": export_code},
            "id": node_id(),
            "name": "Export all models to JSONL",
            "type": "n8n-nodes-base.code",
            "position": [760, 400],
            "typeVersion": 2,
            "credentials": {"odooApi": {"id": "REPLACE_ODOO_CREDENTIAL_ID", "name": "Odoo — Ride Electric (read)"}},
        },
    ]

    connections = {
        "Manual: Start Brisbane EOFY Extract": {"main": [[{"node": "Init snapshot + scope", "type": "main", "index": 0}]]},
        "Init snapshot + scope": {"main": [[{"node": "Export all models to JSONL", "type": "main", "index": 0}]]},
    }

    return {
        "name": "Brisbane EOFY — 01 Odoo Extract to JSONL",
        "nodes": nodes,
        "connections": connections,
        "active": False,
        "settings": {"executionOrder": "v1"},
        "meta": {"templateCredsSetupCompleted": False},
    }


def build_sanitise_workflow() -> dict:
    scope = read_json(CONFIG / "audit-scope.json")
    sanitise = read_text(LIB / "sanitise-core.js")
    profile = read_text(LIB / "profile-core.js")

    code = f"""
const fs = require('fs');
const path = require('path');

{sanitise}
{profile}

const scope = {json.dumps(scope, indent=2)};
const input = $input.first().json;
const snapshotId = input.snapshot_id;
if (!snapshotId) throw new Error('snapshot_id required — pass from workflow 01 output');

const rawRoot = scope.export_paths.raw_root;
const sanitisedRoot = path.join(scope.export_paths.sanitised_root, snapshotId);
const reportRoot = path.join(scope.export_paths.report_root, snapshotId);
fs.mkdirSync(sanitisedRoot, {{ recursive: true }});
fs.mkdirSync(reportRoot, {{ recursive: true }});

const policy = scope.export_defaults.sanitise;
const manifests = [];
const modelSummaries = [];

const rawFiles = fs.readdirSync(rawRoot).filter(f => f.startsWith(snapshotId) && f.endsWith('.jsonl'));

for (const file of rawFiles) {{
  const rawPath = path.join(rawRoot, file);
  const sanitisedPath = path.join(sanitisedRoot, file.replace('.jsonl', '.sanitised.jsonl'));
  const manifestPath = path.join(rawRoot, file.replace('.jsonl', '.manifest.json'));
  let manifest = {{}};
  if (fs.existsSync(manifestPath)) {{
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }}

  const exportKey = manifest.export_key || file.split('__')[2] || 'unknown';
  const lines = fs.readFileSync(rawPath, 'utf8').split('\\n').filter(l => l.trim());
  const outLines = lines.map(line => {{
    const row = JSON.parse(line);
    return JSON.stringify(sanitiseRecord(row, exportKey, policy, file));
  }});
  fs.writeFileSync(sanitisedPath, outLines.join('\\n') + (outLines.length ? '\\n' : ''));
  modelSummaries.push(profileJsonlFile(sanitisedPath, exportKey));
  manifests.push(manifest);
}}

const summary = buildReadinessSummary(snapshotId, {{
  raw_root: rawRoot,
  sanitised_root: sanitisedRoot,
  report_root: reportRoot,
}}, modelSummaries, manifests);

const payloadPath = path.join(reportRoot, 'claude_payload_all.jsonl');
const payloadLines = [];
for (const file of fs.readdirSync(sanitisedRoot).filter(f => f.endsWith('.sanitised.jsonl'))) {{
  const content = fs.readFileSync(path.join(sanitisedRoot, file), 'utf8').split('\\n').filter(l => l.trim());
  for (const line of content) {{
    payloadLines.push(line);
  }}
}}
fs.writeFileSync(payloadPath, payloadLines.join('\\n') + (payloadLines.length ? '\\n' : ''));

const summaryPath = path.join(reportRoot, 'claude_readiness_summary.json');
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

return [{{
  json: {{
    ok: true,
    snapshot_id: snapshotId,
    readiness_status: summary.summary.status,
    summary_path: summaryPath,
    payload_path: payloadPath,
    extraction_errors: summary.extraction_gaps.length,
    total_rows: summary.summary.total_rows,
  }}
}}];
"""

    nodes = [
        {
            "parameters": {},
            "id": node_id(),
            "name": "Manual: Start Sanitise + Profile",
            "type": "n8n-nodes-base.manualTrigger",
            "position": [240, 400],
            "typeVersion": 1,
        },
        sticky(
            "## Sanitise + Claude readiness profile\n"
            "Set `snapshot_id` in the next node to match workflow 01 output.\n"
            "Writes sanitised JSONL + `claude_readiness_summary.json` + `claude_payload_all.jsonl`.",
            200,
            160,
            480,
            180,
        ),
        {
            "parameters": {
                "assignments": {
                    "assignments": [
                        {
                            "id": node_id(),
                            "name": "snapshot_id",
                            "value": "eofy_brisbane_REPLACE_TIMESTAMP",
                            "type": "string",
                        }
                    ]
                },
                "options": {},
            },
            "id": node_id(),
            "name": "Set snapshot_id",
            "type": "n8n-nodes-base.set",
            "position": [480, 400],
            "typeVersion": 3.4,
        },
        {
            "parameters": {"jsCode": code},
            "id": node_id(),
            "name": "Sanitise + profile + combine payload",
            "type": "n8n-nodes-base.code",
            "position": [760, 400],
            "typeVersion": 2,
        },
    ]

    connections = {
        "Manual: Start Sanitise + Profile": {"main": [[{"node": "Set snapshot_id", "type": "main", "index": 0}]]},
        "Set snapshot_id": {"main": [[{"node": "Sanitise + profile + combine payload", "type": "main", "index": 0}]]},
    }

    return {
        "name": "Brisbane EOFY — 02 Sanitise Profile Claude Payload",
        "nodes": nodes,
        "connections": connections,
        "active": False,
        "settings": {"executionOrder": "v1"},
    }


def build_claude_audit_workflow() -> dict:
    scope = read_json(CONFIG / "audit-scope.json")
    audit_tests = read_json(CONFIG / "audit-tests.json")
    join_keys = read_json(CONFIG / "join-keys.json")
    system_prompt = read_text(CONFIG / "claude-audit-system-prompt.txt")

    code_prepare = f"""
const fs = require('fs');
const path = require('path');

const scope = {json.dumps(scope, indent=2)};
const auditTests = {json.dumps(audit_tests, indent=2)};
const joinKeys = {json.dumps(join_keys, indent=2)};
const systemPrompt = {json.dumps(system_prompt)};

const input = $input.first().json;
const snapshotId = input.snapshot_id;
if (!snapshotId) throw new Error('snapshot_id required');

const reportRoot = path.join(scope.export_paths.report_root, snapshotId);
const summaryPath = path.join(reportRoot, 'claude_readiness_summary.json');
const payloadPath = path.join(reportRoot, 'claude_payload_all.jsonl');

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const payloadLines = fs.readFileSync(payloadPath, 'utf8').split('\\n').filter(l => l.trim());

// Token budget: sample up to 800 records stratified by model
const byModel = {{}};
for (const line of payloadLines) {{
  const row = JSON.parse(line);
  const key = row._sanitisation?.model || 'unknown';
  if (!byModel[key]) byModel[key] = [];
  if (byModel[key].length < 40) byModel[key].push(row);
}}
const samplePayload = Object.values(byModel).flat();

const userPayload = {{
  scope: {{
    company_id: scope.company_id,
    business: scope.business,
    fy_start: scope.financial_year_start,
    fy_end: scope.financial_year_end,
    caveats: scope.handover_caveats,
  }},
  readiness_summary: summary.summary,
  extraction_gaps: summary.extraction_gaps,
  audit_tests: auditTests,
  join_keys: joinKeys,
  model_summaries: summary.model_summaries,
  sample_records: samplePayload,
  note: 'Full dataset on n8n server; this payload is a stratified sample for anomaly detection.',
}};

return [{{
  json: {{
    snapshot_id: snapshotId,
    report_root: reportRoot,
    anthropic_body: {{
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{{
        role: 'user',
        content: JSON.stringify(userPayload),
      }}],
    }},
    user_payload_bytes: JSON.stringify(userPayload).length,
  }}
}}];
"""

    code_save = """
const fs = require('fs');
const path = require('path');

const prep = $('Prepare Claude audit request').first().json;
const api = $input.first().json;
const reportRoot = prep.report_root;

let text = '';
if (api.content && Array.isArray(api.content)) {
  text = api.content.map(c => c.text || '').join('');
} else if (typeof api.text === 'string') {
  text = api.text;
} else {
  text = JSON.stringify(api);
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = { raw_text: text, parse_error: true };
}

const outPath = path.join(reportRoot, 'claude_anomaly_report.json');
fs.writeFileSync(outPath, JSON.stringify({
  snapshot_id: prep.snapshot_id,
  generated_at_utc: new Date().toISOString(),
  model: prep.anthropic_body.model,
  report: parsed,
}, null, 2));

return [{
  json: {
    ok: true,
    snapshot_id: prep.snapshot_id,
    report_path: outPath,
    eofy_status: parsed.eofy_readiness?.status || 'unknown',
    anomaly_count: Array.isArray(parsed.anomalies) ? parsed.anomalies.length : 0,
  }
}];
"""

    nodes = [
        {
            "parameters": {},
            "id": node_id(),
            "name": "Manual: Start Claude Audit",
            "type": "n8n-nodes-base.manualTrigger",
            "position": [240, 400],
            "typeVersion": 1,
        },
        sticky(
            "## Claude forensic anomaly scan\n"
            "1. Set snapshot_id from workflow 02.\n"
            "2. Attach Anthropic API credential to HTTP node.\n"
            "3. Output: `claude_anomaly_report.json` in report folder.",
            200,
            160,
            460,
            160,
        ),
        {
            "parameters": {
                "assignments": {
                    "assignments": [
                        {
                            "id": node_id(),
                            "name": "snapshot_id",
                            "value": "eofy_brisbane_REPLACE_TIMESTAMP",
                            "type": "string",
                        }
                    ]
                },
                "options": {},
            },
            "id": node_id(),
            "name": "Set snapshot_id",
            "type": "n8n-nodes-base.set",
            "position": [480, 400],
            "typeVersion": 3.4,
        },
        {
            "parameters": {"jsCode": code_prepare},
            "id": node_id(),
            "name": "Prepare Claude audit request",
            "type": "n8n-nodes-base.code",
            "position": [720, 400],
            "typeVersion": 2,
        },
        {
            "parameters": {
                "method": "POST",
                "url": "https://api.anthropic.com/v1/messages",
                "authentication": "predefinedCredentialType",
                "nodeCredentialType": "anthropicApi",
                "sendHeaders": True,
                "headerParameters": {
                    "parameters": [
                        {"name": "anthropic-version", "value": "2023-06-01"},
                    ]
                },
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={{ $json.anthropic_body }}",
                "options": {},
            },
            "id": node_id(),
            "name": "Claude API — anomaly analysis",
            "type": "n8n-nodes-base.httpRequest",
            "position": [960, 400],
            "typeVersion": 4.2,
            "credentials": {"anthropicApi": {"id": "REPLACE_ANTHROPIC_CREDENTIAL_ID", "name": "Anthropic API"}},
        },
        {
            "parameters": {"jsCode": code_save},
            "id": node_id(),
            "name": "Save anomaly report JSON",
            "type": "n8n-nodes-base.code",
            "position": [1200, 400],
            "typeVersion": 2,
        },
    ]

    connections = {
        "Manual: Start Claude Audit": {"main": [[{"node": "Set snapshot_id", "type": "main", "index": 0}]]},
        "Set snapshot_id": {"main": [[{"node": "Prepare Claude audit request", "type": "main", "index": 0}]]},
        "Prepare Claude audit request": {"main": [[{"node": "Claude API — anomaly analysis", "type": "main", "index": 0}]]},
        "Claude API — anomaly analysis": {"main": [[{"node": "Save anomaly report JSON", "type": "main", "index": 0}]]},
    }

    return {
        "name": "Brisbane EOFY — 03 Claude Anomaly Audit",
        "nodes": nodes,
        "connections": connections,
        "active": False,
        "settings": {"executionOrder": "v1"},
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    workflows = [
        ("01-brisbane-eofy-odoo-extract.workflow.json", build_extract_export_workflow()),
        ("02-brisbane-eofy-sanitise-profile.workflow.json", build_sanitise_workflow()),
        ("03-brisbane-eofy-claude-audit.workflow.json", build_claude_audit_workflow()),
    ]
    for filename, wf in workflows:
        path = OUT / filename
        path.write_text(json.dumps(wf, indent=2), encoding="utf-8")
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
