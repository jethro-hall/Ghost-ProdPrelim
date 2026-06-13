#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { once } = require('events');
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

async function writeDrainable(stream, chunk) {
  if (!stream.write(chunk)) {
    await once(stream, 'drain');
  }
}

async function closeStream(stream) {
  await new Promise((resolve, reject) => {
    stream.end(() => resolve());
    stream.on('error', reject);
  });
}

/**
 * Stream sanitise one raw JSONL file → sanitised JSONL, optionally mirroring rows
 * into the combined Claude payload file. Never loads the full file into memory.
 */
async function streamSanitiseJsonl(rawPath, sanitisedPath, modelKey, policy, exportStage, payloadStream) {
  const out = fs.createWriteStream(sanitisedPath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fs.createReadStream(rawPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let rows = 0;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const row = JSON.parse(trimmed);
      const outRow = sanitiseRecord(row, modelKey, policy, path.basename(rawPath));
      outRow._sanitisation.stage = exportStage;

      const serialised = `${JSON.stringify(outRow)}\n`;
      await writeDrainable(out, serialised);
      if (payloadStream) {
        await writeDrainable(payloadStream, serialised);
      }
      rows += 1;
    }
  } finally {
    rl.close();
    await closeStream(out);
  }

  return rows;
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

(async () => {
  const modelSummaries = [];
  const extractionGaps = [];
  const stageStatuses = [];

  const payloadPath = path.join(manifestRoot, 'claude_payload_all.jsonl');
  const payloadStream = fs.createWriteStream(payloadPath, { encoding: 'utf8' });
  let payloadRows = 0;

  try {
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

        process.stderr.write(
          `[03_sanitise_profile] sanitising ${exportStage}/${file}\n`,
        );

        const rows = await streamSanitiseJsonl(
          rawPath,
          sanitisedPath,
          modelKey,
          policy,
          exportStage,
          payloadStream,
        );
        payloadRows += rows;

        const profile = await profileJsonlFile(sanitisedPath, modelKey);
        profile.stage = exportStage;
        modelSummaries.push(profile);
      }
    }
  } finally {
    await closeStream(payloadStream);
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
    payload_rows: payloadRows,
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

  process.stderr.write(
    `[03_sanitise_profile] snapshot=${snapshotId} models=${modelSummaries.length} ` +
    `rows=${summary.summary.total_rows} payload_rows=${payloadRows}\n`,
  );

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

  process.stdout.write(`${JSON.stringify(result)}\n`);
})().catch((err) => {
  process.stderr.write(`${err.stack || err.message || String(err)}\n`);
  process.exit(1);
});
