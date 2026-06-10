#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const inputPath = process.env.ODOO_04_INPUT || '/tmp/odoo_04_claude_input.json';
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function req(o, k) {
  if (o[k] === undefined || o[k] === null || String(o[k]).trim() === '') {
    throw new Error(`Missing input ${k}`);
  }
  return o[k];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

const configDir = path.join(__dirname, 'eofy-audit-config');
const snapshotId = String(req(input, 'snapshot_id')).trim();
const outputRoot = String(input.output_root || '/home/node/.n8n/odoo_forensic_exports').replace(/\/$/, '');
const snapshotRoot = path.join(outputRoot, snapshotId);
const sanitiseManifestRoot = path.join(snapshotRoot, '03_sanitise_profile', 'manifests');
const auditStageRoot = path.join(snapshotRoot, '04_claude_audit');
const auditManifestRoot = path.join(auditStageRoot, 'manifests');

fs.mkdirSync(auditManifestRoot, { recursive: true });

const summaryPath = path.join(sanitiseManifestRoot, 'claude_readiness_summary.json');
const payloadPath = path.join(sanitiseManifestRoot, 'claude_payload_all.jsonl');

if (!fs.existsSync(summaryPath)) {
  throw new Error(`Missing readiness summary. Run stage 03 first: ${summaryPath}`);
}
if (!fs.existsSync(payloadPath)) {
  throw new Error(`Missing Claude payload. Run stage 03 first: ${payloadPath}`);
}

const scope = readJson(path.join(configDir, 'audit-scope.json'));
const auditTests = readJson(path.join(configDir, 'audit-tests.json'));
const joinKeys = readJson(path.join(configDir, 'join-keys.json'));
const systemPrompt = readText(path.join(configDir, 'claude-audit-system-prompt.txt')).trim();
const summary = readJson(summaryPath);

// Cap per model: keep small so the anthropic_body stays within API limits.
// 301 MB payload → stream line-by-line, stop early once all buckets are full.
const maxPerModel = Math.max(3, Number(input.max_sample_per_model || 10));

const byModel = {};
let totalBuckets = 0;
let fullBuckets = 0;
let linesRead = 0;

async function streamSample() {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(payloadPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      linesRead++;

      let row;
      try { row = JSON.parse(line); } catch { return; }

      const key = `${row._sanitisation?.stage || 'unknown'}::${row._sanitisation?.model || 'unknown'}`;
      if (!byModel[key]) {
        byModel[key] = [];
        totalBuckets++;
      }
      if (byModel[key].length < maxPerModel) {
        byModel[key].push(row);
        if (byModel[key].length === maxPerModel) fullBuckets++;
      }

      // Early-exit once every known bucket is full. We don't know total bucket
      // count upfront, so stop after no new bucket has opened for 5000 lines.
      // This is safe because the payload is ordered by model (stage exports are grouped).
    });

    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

(async () => {
  await streamSample();

  const samplePayload = Object.values(byModel).flat();

  const userPayload = {
    scope: {
      company_id: scope.company_id,
      business: scope.business,
      fy_start: scope.financial_year_start,
      fy_end: scope.financial_year_end,
      caveats: scope.handover_caveats,
    },
    readiness_summary: summary.summary,
    stage_statuses: summary.stage_statuses || [],
    extraction_gaps: summary.extraction_gaps || [],
    audit_tests: auditTests,
    join_keys: joinKeys,
    model_summaries: summary.model_summaries || [],
    sample_records: samplePayload,
    note: `Stratified sample (${maxPerModel} records/model) from sanitised forensic export; full dataset on n8n volume.`,
  };

  const claudeModel = String(input.claude_model || 'claude-sonnet-4-20250514').trim();
  const anthropicBody = {
    model: claudeModel,
    max_tokens: Math.min(8192, Number(input.max_tokens || 8192)),
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: JSON.stringify(userPayload),
    }],
  };

  // Write the large body to a file — do NOT include it in stdout.
  // n8n executeCommand has a small stdout buffer (~200 KB); the body can be MB.
  const anthropicBodyPath = '/tmp/odoo_04_anthropic_body.json';
  fs.writeFileSync(anthropicBodyPath, JSON.stringify(anthropicBody), 'utf8');

  const userPayloadBytes = JSON.stringify(userPayload).length;
  process.stderr.write(
    `[04_claude_prepare] snapshot=${snapshotId} models=${totalBuckets} ` +
    `samples=${samplePayload.length} payload_bytes=${userPayloadBytes} ` +
    `lines_read=${linesRead} body_path=${anthropicBodyPath}\n`
  );

  // Compact result — only metadata and file path to stdout.
  const result = {
    subworkflow: '04_SUB_CLAUDE_AUDIT',
    snapshot_id: snapshotId,
    stage_root: auditStageRoot,
    report_root: auditManifestRoot,
    summary_path: summaryPath,
    payload_path: payloadPath,
    claude_model: claudeModel,
    user_payload_bytes: userPayloadBytes,
    sample_records: samplePayload.length,
    anthropic_body_path: anthropicBodyPath,
  };

  process.stdout.write(JSON.stringify(result) + '\n');
})().catch((err) => {
  process.stderr.write((err.stack || err.message || String(err)) + '\n');
  process.exit(1);
});
