#!/usr/bin/env node
'use strict';

/**
 * 06_raw_github_push.js
 *
 * Stage 06 — Raw JSONL → GitHub (raw_data/{snapshot_id}/)
 *
 * Pushes byte-for-byte Odoo JSONL exports from local snapshot volume to:
 *   https://github.com/jethro-hall/Claudeopus_Odoo_Audit/raw_data/{snapshot_id}/
 *
 * Uses git + GITHUB_PAT (no gh CLI required — works inside n8n container).
 *
 * Required env: GITHUB_PAT
 * Input: /tmp/odoo_06_raw_push_input.json  { snapshot_id, output_root?, dry_run? }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const zlib = require('zlib');

const inputPath = process.env.ODOO_06_RAW_PUSH_INPUT || '/tmp/odoo_06_raw_push_input.json';
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const GITHUB_PAT = process.env.GITHUB_PAT || '';
const GITHUB_OWNER = 'jethro-hall';
const GITHUB_REPO = 'Claudeopus_Odoo_Audit';
const GITHUB_BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';
const SPLIT_BYTES = 95 * 1024 * 1024;
const COMPRESS = input.compress !== false;

if (!GITHUB_PAT) {
  throw new Error('GITHUB_PAT env var is not set.');
}

function req(o, k) {
  if (o[k] === undefined || o[k] === null || String(o[k]).trim() === '') {
    throw new Error(`Missing input field: ${k}`);
  }
  return o[k];
}

const snapshotId = String(req(input, 'snapshot_id')).trim();
const outputRoot = String(input.output_root || '/home/node/.n8n/odoo_forensic_exports').replace(/\/$/, '');
const snapshotRoot = path.join(outputRoot, snapshotId);
const dryRun = Boolean(input.dry_run);

function safeJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadProvenance(root) {
  const ctx = safeJson(path.join(root, 'snapshot_run_context.json')) || {};
  return {
    fy_start: ctx.date_start || '2024-07-01',
    fy_end: ctx.date_end || '2025-06-30',
    period_label: ctx.period_label || null,
    company_name: ctx.company_name || 'Ride Electric Brisbane',
    company_id: ctx.company_id || 4,
  };
}

function sh(cmd, opts = {}) {
  const execOpts = { encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit' };
  if (opts.cwd) execOpts.cwd = opts.cwd;
  return execSync(cmd, execOpts);
}

function shQuiet(cmd, opts = {}) {
  const execOpts = { encoding: 'utf8', stdio: 'pipe' };
  if (opts.cwd) execOpts.cwd = opts.cwd;
  return execSync(cmd, execOpts).trim();
}

function collectRawFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const stageDir of fs.readdirSync(root)) {
    const rawDir = path.join(root, stageDir, 'raw');
    if (!fs.existsSync(rawDir) || !fs.statSync(rawDir).isDirectory()) continue;
    for (const f of fs.readdirSync(rawDir).sort()) {
      if (f.endsWith('.jsonl')) files.push(path.join(rawDir, f));
    }
  }
  return files;
}

function countLines(file) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    if (!data) return 0;
    return data.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function prepareDestFiles(sourceFiles, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const prepared = [];

  for (const src of sourceFiles) {
    const model = path.basename(src, '.jsonl');
    const rows = countLines(src);
    let destName = COMPRESS ? `${model}.jsonl.gz` : `${model}.jsonl`;
    const destPath = path.join(destDir, destName);

    if (COMPRESS) {
      const gz = zlib.gzipSync(fs.readFileSync(src));
      fs.writeFileSync(destPath, gz);
    } else {
      fs.copyFileSync(src, destPath);
    }

    let finalPath = destPath;
    let finalBytes = fs.statSync(destPath).size;

    if (finalBytes > SPLIT_BYTES) {
      const partPrefix = `${destPath}.part.`;
      sh(`split --bytes=${SPLIT_BYTES} --suffix-length=2 --numeric-suffixes "${destPath}" "${partPrefix}"`, { silent: true });
      fs.unlinkSync(destPath);
      const parts = fs.readdirSync(destDir).filter((f) => f.startsWith(`${destName}.part.`)).sort();
      prepared.push({ model, rows, parts: parts.map((p) => path.join(destDir, p)), split: true });
    } else {
      prepared.push({ model, rows, path: finalPath, bytes: finalBytes, split: false });
    }
  }
  return prepared;
}

function writeSnapshotReadme(destDir, sourceFiles, prov) {
  const period = prov.period_label
    ? `${prov.period_label} (${prov.fy_start} → ${prov.fy_end})`
    : `${prov.fy_start} → ${prov.fy_end}`;

  let readme = `# Odoo Raw Export — ${snapshotId}

## Source
- **Company**: ${prov.company_name} (company_id=${prov.company_id})
- **FY period**: ${period}
- **Extracted**: ${new Date().toISOString()}
- **Snapshot ID**: ${snapshotId}

## Integrity
Files in this directory are **raw, unmodified JSONL** as extracted from the Odoo JSON-RPC API.
No sanitisation, no PII hashing, no field filtering, no row filtering.

Compressed files (.jsonl.gz) decompress with: \`gunzip *.gz\`
Split files (.part.00, .part.01, …) reassemble with: \`cat model.jsonl.gz.part.* > model.jsonl.gz\`

## Models included
`;

  for (const f of sourceFiles) {
    const model = path.basename(f, '.jsonl');
    readme += `- ${model.padEnd(45)}  ${countLines(f)} rows\n`;
  }

  fs.writeFileSync(path.join(destDir, 'README.md'), readme, 'utf8');
}

function copyMetadata(snapshotRoot, destDir) {
  for (const stageDir of fs.readdirSync(snapshotRoot)) {
    const stagePath = path.join(snapshotRoot, stageDir);
    if (!fs.statSync(stagePath).isDirectory()) continue;
    for (const f of fs.readdirSync(stagePath)) {
      if (!f.endsWith('.json')) continue;
      const metaDest = path.join(destDir, 'metadata', stageDir);
      fs.mkdirSync(metaDest, { recursive: true });
      fs.copyFileSync(path.join(stagePath, f), path.join(metaDest, f));
    }
  }
}

async function githubRequest(method, urlPath, body) {
  const res = await fetch(`${GITHUB_API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`GitHub API ${method} ${urlPath}: ${json.message || res.status}`);
  return json;
}

async function getFileSha(repoPath) {
  try {
    const data = await githubRequest('GET',
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}?ref=${GITHUB_BRANCH}`);
    return data.sha || null;
  } catch {
    return null;
  }
}

async function pushJsonFile(localObj, repoPath, message) {
  const contentB64 = Buffer.from(JSON.stringify(localObj, null, 2), 'utf8').toString('base64');
  const sha = await getFileSha(repoPath);
  const body = { message, content: contentB64, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  await githubRequest('PUT', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}`, body);
}

async function updateAuditPayloadRawStatus(totalRows, filesPushed) {
  const repoPath = `snapshots/${snapshotId}/audit_payload.json`;
  try {
    const data = await githubRequest('GET',
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}?ref=${GITHUB_BRANCH}`);
    const payload = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    payload.raw_data = {
      status: 'complete',
      repo_path: `raw_data/${snapshotId}/`,
      repo_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${GITHUB_BRANCH}/raw_data/${snapshotId}/`,
      model_count: filesPushed,
      total_rows: totalRows,
      pushed_at: new Date().toISOString(),
      note: 'Byte-for-byte Odoo API output. Private repo. Not sanitised.',
    };
    await pushJsonFile(payload, repoPath, `audit: mark raw_data complete for ${snapshotId}`);
    return true;
  } catch (err) {
    process.stderr.write(`[06_raw_github_push] audit_payload update skipped: ${err.message}\n`);
    return false;
  }
}

function gitPushRawData(sourceFiles, prov) {
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odoo-raw-push-'));
  const authUrl = `https://x-access-token:${GITHUB_PAT}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;
  const rawDest = `raw_data/${snapshotId}`;

  try {
    sh(`git clone --branch ${GITHUB_BRANCH} --depth 1 "${authUrl}" "${cloneDir}"`, { silent: true });
    const destDir = path.join(cloneDir, rawDest);
    fs.mkdirSync(destDir, { recursive: true });

    writeSnapshotReadme(destDir, sourceFiles, prov);
    const prepared = prepareDestFiles(sourceFiles, destDir);
    copyMetadata(snapshotRoot, destDir);

    sh('git config user.email "research@rideelectric.com.au"', { cwd: cloneDir, silent: true });
    sh('git config user.name "GhostDash EOFY Audit"', { cwd: cloneDir, silent: true });
    sh('git add -A', { cwd: cloneDir, silent: true });

    const status = shQuiet('git status --porcelain', { cwd: cloneDir });
    if (!status) {
      return { changed: false, prepared };
    }

    const period = prov.period_label
      ? `${prov.period_label} (${prov.fy_start} → ${prov.fy_end})`
      : `${prov.fy_start} → ${prov.fy_end}`;

    const msg = [
      `feat: upload raw Odoo EOFY export — ${snapshotId}`,
      `Company: ${prov.company_name} (company_id=${prov.company_id})`,
      `FY: ${period}`,
      `Files: ${sourceFiles.length} models, raw JSONL (${COMPRESS ? 'gzip' : 'plain'})`,
      'No sanitisation. Byte-for-byte Odoo API output.',
    ].join('\n');

    const msgPath = path.join(cloneDir, '.commit-msg.txt');
    fs.writeFileSync(msgPath, msg, 'utf8');
    sh(`git commit -F "${msgPath}"`, { cwd: cloneDir, silent: true });
    sh(`git push origin ${GITHUB_BRANCH}`, { cwd: cloneDir, silent: true });

    return { changed: true, prepared };
  } finally {
    fs.rmSync(cloneDir, { recursive: true, force: true });
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(snapshotRoot)) {
    throw new Error(`Snapshot not found: ${snapshotRoot}`);
  }

  const sourceFiles = collectRawFiles(snapshotRoot);
  if (sourceFiles.length === 0) {
    throw new Error(`No raw .jsonl files found under ${snapshotRoot}`);
  }

  const prov = loadProvenance(snapshotRoot);
  const totalRows = sourceFiles.reduce((sum, f) => sum + countLines(f), 0);

  process.stderr.write(`[06_raw_github_push] snapshot=${snapshotId} raw_files=${sourceFiles.length} total_rows=${totalRows} dry_run=${dryRun}\n`);

  if (dryRun) {
    const result = {
      subworkflow: '06_SUB_RAW_GITHUB_PUSH',
      status: 'dry_run',
      snapshot_id: snapshotId,
      files_found: sourceFiles.length,
      total_rows: totalRows,
      raw_data_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${GITHUB_BRANCH}/raw_data/${snapshotId}/`,
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  const { changed, prepared } = gitPushRawData(sourceFiles, prov);
  const auditPayloadUpdated = await updateAuditPayloadRawStatus(totalRows, sourceFiles.length);

  const stageRoot = path.join(snapshotRoot, '06_raw_github_push');
  const manifestRoot = path.join(stageRoot, 'manifests');
  fs.mkdirSync(manifestRoot, { recursive: true });

  const stagePack = {
    snapshot_id: snapshotId,
    status: 'success',
    pushed_at: new Date().toISOString(),
    files_pushed: sourceFiles.length,
    total_rows: totalRows,
    git_changed: changed,
    audit_payload_updated: auditPayloadUpdated,
    raw_data_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${GITHUB_BRANCH}/raw_data/${snapshotId}/`,
    models: prepared.map((p) => ({ model: p.model, rows: p.rows, split: p.split })),
  };

  fs.writeFileSync(
    path.join(manifestRoot, 'raw_push_stage_pack.json'),
    JSON.stringify(stagePack, null, 2),
    'utf8',
  );

  const result = {
    subworkflow: '06_SUB_RAW_GITHUB_PUSH',
    status: changed ? 'success' : 'unchanged',
    snapshot_id: snapshotId,
    files_pushed: sourceFiles.length,
    total_rows: totalRows,
    raw_data_url: stagePack.raw_data_url,
    audit_payload_updated: auditPayloadUpdated,
    stage_pack_path: path.join(manifestRoot, 'raw_push_stage_pack.json'),
  };

  process.stdout.write(JSON.stringify(result) + '\n');
})().catch((err) => {
  process.stderr.write((err.stack || err.message || String(err)) + '\n');
  process.exit(1);
});
