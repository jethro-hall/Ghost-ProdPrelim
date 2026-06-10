#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const inputPath = process.env.ODOO_04_CALL_INPUT || '/tmp/odoo_04_claude_call_input.json';
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function req(o, k) {
  if (o[k] === undefined || o[k] === null || String(o[k]).trim() === '') {
    throw new Error(`Missing input ${k}`);
  }
  return o[k];
}

const apiKey = String(
  input.anthropic_api_key ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  '',
).trim();

if (!apiKey) {
  throw new Error(
    'No Anthropic API key. Set ANTHROPIC_API_KEY on the n8n container (.env + docker compose) ' +
    'or update the Anthropic credential in n8n (Credentials → Anthropic account).',
  );
}

if (!apiKey.startsWith('sk-ant-')) {
  throw new Error(
    'Anthropic API key does not look valid (expected prefix sk-ant-). Update ANTHROPIC_API_KEY or n8n credential.',
  );
}

const snapshotId = String(req(input, 'snapshot_id')).trim();
const reportRoot = String(req(input, 'report_root')).trim();
const stageRoot = String(input.stage_root || path.join(reportRoot, '..')).trim();
const claudeModel = String(input.claude_model || input.anthropic_body?.model || 'claude-sonnet-4-20250514');
const anthropicBody = input.anthropic_body;
if (!anthropicBody || !anthropicBody.messages) {
  throw new Error('Missing anthropic_body in call input — run Claude prepare first');
}

(async () => {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicBody),
  });

  const api = await response.json();
  if (!response.ok) {
    const msg = api?.error?.message || api?.message || `HTTP ${response.status}`;
    throw new Error(`Claude API error: ${msg}`);
  }

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
})().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
