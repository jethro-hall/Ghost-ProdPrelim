#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { sanitiseRecord } = require('./sanitise-core');
const { profileJsonlFile, buildForensicReadinessSummary } = require('./profile-core');

const inputPath = process.env.ODOO_03_INPUT || '/tmp/odoo_03_sanitise_input.json';
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function req(o, k) {
  if (o[k] === undefined || o[k] === null || String(o[k]).trim() === '') {
    throw new Error(`Missing input ${k}`);
  }
  return o[k];
}

function mkdir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const snapshotId = String(req(input, 'snapshot_id')).trim();
const outputRoot = String(input.output_root || '/home/node/.n8n/odoo_forensic_exports').replace(/\/$/, '');
const snapshotRoot = path.join(outputRoot, snapshotId);
const stageName = '03_sanitise_profile';
const stageRoot = path.join(snapshotRoot, stageName);
const sanitisedRoot = path.join(stageRoot, 'sanitised');
const manifestRoot = path.join(stageRoot, 'manifests');

const exportStages = Array.isArray(input.export_stages) && input.export_stages.length
  ? input.export_stages
  : ['01_account_ledger', '02_pos_retail'];

const scopePath = path.join(__dirname, 'eofy-audit-config', 'audit-scope.json');
const scope = readJsonIfExists(scopePath, {
  export_defaults: {
    sanitise: {
      partner_names_hashed: true,
      bank_details_redacted: true,
      descriptions_compacted: true,
      text_compact_max_len: 64,
    },
  },
});

const policy = { ...scope.export_defaults.sanitise, ...(input.sanitise_policy || {}) };
const started = new Date().toISOString();

mkdir(sanitisedRoot);
mkdir(manifestRoot);

const modelSummaries = [];
const extractionGaps = [];
const stageStatuses = [];

for (const exportStage of exportStages) {
  const stageDir = path.join(snapshotRoot, exportStage);
  const rawDir = path.join(stageDir, 'raw');
  const stageManifestDir = path.join(stageDir, 'manifests');

  const subResult = readJsonIfExists(path.join(stageManifestDir, 'subworkflow_result.json'));
  if (subResult) {
    stageStatuses.push({
      stage: exportStage,
      status: subResult.status || 'unknown',
      subworkflow: subResult.subworkflow || exportStage,
      models_exported: subResult.models_exported || [],
      models_attempted: subResult.models_attempted || [],
    });

    if (subResult.status === 'partial' || subResult.status === 'error') {
      const attempted = subResult.models_attempted || [];
      const exported = new Set(subResult.models_exported || []);
      for (const model of attempted) {
        if (!exported.has(model)) {
          extractionGaps.push({
            stage: exportStage,
            model,
            status: subResult.status,
            error: `Model not exported in ${exportStage} (${subResult.status})`,
          });
        }
      }
    }
  }

  const apiErrors = readJsonIfExists(path.join(stageManifestDir, 'api_errors.json'), []);
  if (Array.isArray(apiErrors)) {
    for (const err of apiErrors) {
      extractionGaps.push({
        stage: exportStage,
        model: err.model || 'unknown',
        status: 'api_error',
        error: String(err.error || err.message || 'unknown').split('\n')[0],
        method: err.method || null,
      });
    }
  }

  if (!fs.existsSync(rawDir)) {
    extractionGaps.push({
      stage: exportStage,
      model: '*',
      status: 'missing_raw_dir',
      error: `Raw export directory not found: ${rawDir}`,
    });
    continue;
  }

  const jsonlFiles = fs.readdirSync(rawDir).filter((f) => f.endsWith('.jsonl')).sort();
  for (const file of jsonlFiles) {
    const modelKey = file.replace(/\.jsonl$/, '');
    const rawPath = path.join(rawDir, file);
    const outDir = path.join(sanitisedRoot, exportStage);
    mkdir(outDir);
    const sanitisedPath = path.join(outDir, `${modelKey}.sanitised.jsonl`);

    const lines = fs.readFileSync(rawPath, 'utf8').split('\n').filter((l) => l.trim());
    const outLines = lines.map((line) => {
      const row = JSON.parse(line);
      const out = sanitiseRecord(row, modelKey, policy, file);
      out._sanitisation.stage = exportStage;
      return JSON.stringify(out);
    });
    fs.writeFileSync(sanitisedPath, outLines.join('\n') + (outLines.length ? '\n' : ''), 'utf8');

    const profile = profileJsonlFile(sanitisedPath, modelKey);
    profile.stage = exportStage;
    modelSummaries.push(profile);
  }
}

const summary = buildForensicReadinessSummary(
  snapshotId,
  {
    snapshot_root: snapshotRoot,
    sanitised_root: sanitisedRoot,
    report_root: manifestRoot,
  },
  modelSummaries,
  extractionGaps,
  stageStatuses,
);

const payloadPath = path.join(manifestRoot, 'claude_payload_all.jsonl');
const payloadLines = [];
for (const exportStage of exportStages) {
  const stageSanDir = path.join(sanitisedRoot, exportStage);
  if (!fs.existsSync(stageSanDir)) continue;
  for (const file of fs.readdirSync(stageSanDir).filter((f) => f.endsWith('.sanitised.jsonl')).sort()) {
    const content = fs.readFileSync(path.join(stageSanDir, file), 'utf8').split('\n').filter((l) => l.trim());
    payloadLines.push(...content);
  }
}
fs.writeFileSync(payloadPath, payloadLines.join('\n') + (payloadLines.length ? '\n' : ''), 'utf8');

const summaryPath = path.join(manifestRoot, 'claude_readiness_summary.json');
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

const stagePack = {
  subworkflow: '03_SUB_SANITISE_PROFILE',
  status: summary.summary.ok ? 'success' : 'partial',
  snapshot_id: snapshotId,
  started_at: started,
  completed_at: new Date().toISOString(),
  readiness_status: summary.summary.status,
  models_sanitised: modelSummaries.length,
  total_rows: summary.summary.total_rows,
  extraction_gaps: extractionGaps.length,
  paths: {
    stage_root: stageRoot,
    sanitised_root: sanitisedRoot,
    summary_path: summaryPath,
    payload_path: payloadPath,
  },
};

const stagePackPath = path.join(manifestRoot, 'sanitise_profile_stage_pack.json');
fs.writeFileSync(stagePackPath, JSON.stringify(stagePack, null, 2), 'utf8');

const result = {
  subworkflow: '03_SUB_SANITISE_PROFILE',
  status: stagePack.status,
  readiness_status: summary.summary.status,
  snapshot_id: snapshotId,
  summary_path: summaryPath,
  payload_path: payloadPath,
  stage_root: stageRoot,
  extraction_gaps: extractionGaps.length,
  total_rows: summary.summary.total_rows,
  models_sanitised: modelSummaries.length,
  pii_after_total: summary.summary.pii_after_total,
};

process.stdout.write(JSON.stringify(result) + '\n');
