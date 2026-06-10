#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const inputPath = process.env.ODOO_04_SAVE_INPUT || '/tmp/odoo_04_claude_save_input.json';
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function req(o, k) {
  if (o[k] === undefined || o[k] === null || String(o[k]).trim() === '') {
    throw new Error(`Missing input ${k}`);
  }
  return o[k];
}

const snapshotId = String(req(input, 'snapshot_id')).trim();
const reportRoot = String(req(input, 'report_root')).trim();
const stageRoot = String(input.stage_root || path.join(reportRoot, '..')).trim();
const api = input.api_response || input;
const claudeModel = String(input.claude_model || 'claude-sonnet-4-20250514');

let text = '';
if (api.content && Array.isArray(api.content)) {
  text = api.content.map((c) => c.text || '').join('');
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

fs.mkdirSync(reportRoot, { recursive: true });

const reportPath = path.join(reportRoot, 'claude_anomaly_report.json');
const reportDoc = {
  snapshot_id: snapshotId,
  generated_at_utc: new Date().toISOString(),
  model: claudeModel,
  report: parsed,
};

fs.writeFileSync(reportPath, JSON.stringify(reportDoc, null, 2), 'utf8');

const stagePackPath = path.join(reportRoot, 'claude_audit_stage_pack.json');
const stagePack = {
  subworkflow: '04_SUB_CLAUDE_AUDIT',
  status: parsed.parse_error ? 'partial' : 'success',
  snapshot_id: snapshotId,
  stage_root: stageRoot,
  report_path: reportPath,
  eofy_status: parsed.eofy_readiness?.status || 'unknown',
  anomaly_count: Array.isArray(parsed.anomalies) ? parsed.anomalies.length : 0,
  completed_at: new Date().toISOString(),
};
fs.writeFileSync(stagePackPath, JSON.stringify(stagePack, null, 2), 'utf8');

const result = {
  subworkflow: '04_SUB_CLAUDE_AUDIT',
  status: stagePack.status,
  snapshot_id: snapshotId,
  report_path: reportPath,
  stage_root: stageRoot,
  eofy_status: stagePack.eofy_status,
  anomaly_count: stagePack.anomaly_count,
};

process.stdout.write(JSON.stringify(result) + '\n');
