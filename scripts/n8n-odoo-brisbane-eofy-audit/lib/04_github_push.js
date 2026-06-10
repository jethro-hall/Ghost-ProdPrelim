#!/usr/bin/env node
'use strict';

/**
 * 04_github_push.js
 *
 * Stage 04 — Audit Package → GitHub
 *
 * Replaces the Claude API call. Collects every JSON artifact produced by
 * Stages 01-03 plus the prepared audit payload (anthropic_body) and commits
 * them all to the GitHub repo under:
 *
 *   scripts/n8n-odoo-brisbane-eofy-audit/audit-exports/{snapshot_id}/
 *
 * Opus then reads these files directly from the repo during an interactive
 * audit session instead of receiving a canned Claude response.
 *
 * Required env var: GITHUB_PAT
 *   A Personal Access Token with Contents:write scope on the repo.
 *   Add to docker-compose.yml: GITHUB_PAT=ghp_...
 */

const fs = require('fs');
const path = require('path');

const inputPath = process.env.ODOO_04_CALL_INPUT || '/tmp/odoo_04_claude_call_input.json';
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const GITHUB_PAT = process.env.GITHUB_PAT || '';
const GITHUB_OWNER = 'jethro-hall';
const GITHUB_REPO = 'Claudeopus_Odoo_Audit';
const GITHUB_BRANCH = 'main';
const GITHUB_API = 'https://api.github.com';

if (!GITHUB_PAT) {
  throw new Error(
    'GITHUB_PAT env var is not set. Add it to docker-compose.yml and restart the n8n container.'
  );
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
const anthropicBodyPath = input.anthropic_body_path || '/tmp/odoo_04_anthropic_body.json';

// Destination prefix in the audit repo — files land at root/snapshots/{id}/
const repoPrefix = `snapshots/${snapshotId}`;

// ── Collect files to push ──────────────────────────────────────────────────────
function collectFile(localPath, repoRelPath) {
  if (!fs.existsSync(localPath)) return null;
  return { localPath, repoPath: `${repoPrefix}/${repoRelPath}` };
}

const filesToPush = [
  // Prepared audit payload (samples + system prompt assembled by prepare step)
  collectFile(anthropicBodyPath, 'audit_payload.json'),

  // Stage 01 — Account Ledger
  collectFile(path.join(snapshotRoot, '01_account_ledger/metrics/account_ledger_metric_pack.json'), '01_account_ledger/metric_pack.json'),
  collectFile(path.join(snapshotRoot, '01_account_ledger/anomalies/account_ledger_anomaly_pack.json'), '01_account_ledger/anomaly_pack.json'),
  collectFile(path.join(snapshotRoot, '01_account_ledger/manifests/account_ledger_stage_pack.json'), '01_account_ledger/stage_pack.json'),
  collectFile(path.join(snapshotRoot, '01_account_ledger/manifests/model_counts.json'), '01_account_ledger/model_counts.json'),
  collectFile(path.join(snapshotRoot, '01_account_ledger/manifests/api_errors.json'), '01_account_ledger/api_errors.json'),

  // Stage 02 — POS Retail
  collectFile(path.join(snapshotRoot, '02_pos_retail/metrics/pos_retail_metric_pack.json'), '02_pos_retail/metric_pack.json'),
  collectFile(path.join(snapshotRoot, '02_pos_retail/anomalies/pos_retail_anomaly_pack.json'), '02_pos_retail/anomaly_pack.json'),
  collectFile(path.join(snapshotRoot, '02_pos_retail/manifests/pos_retail_stage_pack.json'), '02_pos_retail/stage_pack.json'),
  collectFile(path.join(snapshotRoot, '02_pos_retail/manifests/model_counts.json'), '02_pos_retail/model_counts.json'),
  collectFile(path.join(snapshotRoot, '02_pos_retail/manifests/api_errors.json'), '02_pos_retail/api_errors.json'),

  // Stage 03 — Sanitise + Profile
  collectFile(path.join(snapshotRoot, '03_sanitise_profile/manifests/claude_readiness_summary.json'), '03_sanitise_profile/readiness_summary.json'),
  collectFile(path.join(snapshotRoot, '03_sanitise_profile/manifests/sanitise_profile_stage_pack.json'), '03_sanitise_profile/stage_pack.json'),

  // Stage 05 — Master Data (populated after Stage 05 runs)
  collectFile(path.join(snapshotRoot, '05_master_data/metrics/master_data_metric_pack.json'), '05_master_data/metric_pack.json'),
  collectFile(path.join(snapshotRoot, '05_master_data/anomalies/master_data_anomaly_pack.json'), '05_master_data/anomaly_pack.json'),
  collectFile(path.join(snapshotRoot, '05_master_data/manifests/stage_pack.json'), '05_master_data/stage_pack.json'),
  collectFile(path.join(snapshotRoot, '05_master_data/manifests/model_counts.json'), '05_master_data/model_counts.json'),
].filter(Boolean);

// ── GitHub API helpers ─────────────────────────────────────────────────────────
async function githubRequest(method, urlPath, body) {
  const res = await fetch(`${GITHUB_API}${urlPath}`, {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_PAT}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json.message || `HTTP ${res.status}`;
    throw new Error(`GitHub API error on ${method} ${urlPath}: ${msg}`);
  }
  return json;
}

async function getFileSha(repoPath) {
  try {
    const data = await githubRequest('GET',
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}?ref=${GITHUB_BRANCH}`
    );
    return data.sha || null;
  } catch {
    return null;
  }
}

async function pushFile(localPath, repoPath) {
  const content = fs.readFileSync(localPath);
  const contentB64 = content.toString('base64');
  const sha = await getFileSha(repoPath);
  const body = {
    message: `audit: push ${path.basename(repoPath)} for ${snapshotId}`,
    content: contentB64,
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await githubRequest('PUT',
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}`,
    body
  );
  return res.content?.html_url || repoPath;
}

// ── Build package manifest ─────────────────────────────────────────────────────
function buildManifest(pushedFiles, errors) {
  return {
    snapshot_id: snapshotId,
    pushed_at: new Date().toISOString(),
    repo: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
    branch: GITHUB_BRANCH,
    audit_exports_path: repoPrefix,
    audit_exports_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${GITHUB_BRANCH}/${repoPrefix}`,
    files_pushed: pushedFiles.length,
    errors: errors.length,
    pushed_files: pushedFiles,
    push_errors: errors,
    opus_entry_point: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${repoPrefix}/audit_payload.json`,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  const pushed = [];
  const errors = [];

  process.stderr.write(`[04_github_push] snapshot=${snapshotId} files_to_push=${filesToPush.length}\n`);

  for (const { localPath, repoPath } of filesToPush) {
    try {
      const url = await pushFile(localPath, repoPath);
      pushed.push({ repoPath, url });
      process.stderr.write(`  pushed: ${repoPath}\n`);
    } catch (err) {
      errors.push({ repoPath, error: err.message });
      process.stderr.write(`  ERROR: ${repoPath} — ${err.message}\n`);
    }
  }

  // Build and push the package manifest last
  const manifest = buildManifest(pushed, errors);
  const manifestPath = '/tmp/odoo_04_audit_package_manifest.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  try {
    await pushFile(manifestPath, `${repoPrefix}/audit_package_manifest.json`);
    pushed.push({ repoPath: `${repoPrefix}/audit_package_manifest.json` });
  } catch (err) {
    errors.push({ repoPath: 'audit_package_manifest.json', error: err.message });
  }

  // Write stage pack
  const stageRoot = path.join(snapshotRoot, '04_github_push');
  const stageManifestRoot = path.join(stageRoot, 'manifests');
  fs.mkdirSync(stageManifestRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stageManifestRoot, 'github_push_stage_pack.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  const result = {
    subworkflow: '04_SUB_CLAUDE_AUDIT',
    status: errors.length === 0 ? 'success' : errors.length < pushed.length ? 'partial' : 'error',
    snapshot_id: snapshotId,
    files_pushed: pushed.length,
    errors: errors.length,
    audit_exports_url: manifest.audit_exports_url,
    opus_entry_point: manifest.opus_entry_point,
    stage_pack_path: path.join(stageManifestRoot, 'github_push_stage_pack.json'),
  };

  process.stdout.write(JSON.stringify(result) + '\n');
})().catch((err) => {
  process.stderr.write((err.stack || err.message || String(err)) + '\n');
  process.exit(1);
});
