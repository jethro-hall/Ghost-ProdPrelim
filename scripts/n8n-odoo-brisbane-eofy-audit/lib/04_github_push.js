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

function safeJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadSnapshotScope(root) {
  const fallback = {
    company: 'Ride Electric Brisbane',
    company_id: 4,
    fy_start: '2024-07-01',
    fy_end: '2025-06-30',
    timezone: 'Australia/Brisbane',
    currency: 'AUD',
    note: 'Brisbane entity only. Do not extrapolate to other Ride Electric entities.',
  };
  const candidates = [
    path.join(root, 'snapshot_run_context.json'),
    path.join(root, '02_pos_retail/manifests/pos_retail_stage_pack.json'),
    path.join(root, '01_account_ledger/manifests/account_ledger_stage_pack.json'),
  ];
  for (const p of candidates) {
    const j = safeJson(p);
    if (!j) continue;
    const period = j.period || j;
    const start = period.start || period.date_start || j.date_start || j.fy_start;
    const end = period.end || period.date_end || j.date_end || j.fy_end;
    if (start && end) {
      return {
        company: j.company?.name || j.company_name || fallback.company,
        company_id: j.company?.id || j.company_id || fallback.company_id,
        fy_start: start,
        fy_end: end,
        timezone: period.timezone || j.timezone || fallback.timezone,
        currency: 'AUD',
        period_label: j.period_label || null,
        note: fallback.note,
      };
    }
  }
  return fallback;
}

function addDaysIso(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function countRawJsonlFiles(root) {
  let count = 0;
  if (!fs.existsSync(root)) return 0;
  for (const stageDir of fs.readdirSync(root)) {
    const rawDir = path.join(root, stageDir, 'raw');
    if (!fs.existsSync(rawDir) || !fs.statSync(rawDir).isDirectory()) continue;
    for (const f of fs.readdirSync(rawDir)) {
      if (f.endsWith('.jsonl')) count += 1;
    }
  }
  return count;
}

function collectExtractedModels(root) {
  const models = new Set();
  if (!fs.existsSync(root)) return models;
  for (const stageDir of fs.readdirSync(root)) {
    const rawDir = path.join(root, stageDir, 'raw');
    if (!fs.existsSync(rawDir) || !fs.statSync(rawDir).isDirectory()) continue;
    for (const f of fs.readdirSync(rawDir)) {
      if (f.endsWith('.jsonl')) models.add(f.replace(/\.jsonl$/, ''));
    }
  }
  return models;
}

function loadApiErrors(root) {
  const errors = [];
  for (const stage of ['01_account_ledger', '02_pos_retail', '05_master_data']) {
    const p = path.join(root, stage, 'manifests/api_errors.json');
    const j = safeJson(p);
    if (!j) continue;
    const list = Array.isArray(j) ? j : (j.errors || []);
    for (const e of list) errors.push({ stage, ...e });
  }
  return errors;
}

function buildExtractionGaps(snapshotRoot, m05) {
  const gaps = [];
  const counts05 = safeJson(path.join(snapshotRoot, '05_master_data/manifests/model_counts.json')) || m05?.model_counts || {};
  const extracted = collectExtractedModels(snapshotRoot);
  const apiErrors = loadApiErrors(snapshotRoot);

  const mailCount = counts05['mail.message'] || 0;
  const trackingCount = counts05['mail.tracking.value'] || 0;
  if (mailCount > 0) {
    gaps.push(`mail.message: extracted (${mailCount} rows) — audit trail available via raw_data and MCP after Stage 03 re-run on 05_master_data`);
  } else {
    gaps.push('mail.message: not extracted — audit trail unavailable');
  }
  if (trackingCount > 0) {
    gaps.push(`mail.tracking.value: extracted (${trackingCount} rows)`);
  } else {
    const trackingDenied = apiErrors.some((e) => String(e.model || '').includes('mail.tracking.value'));
    gaps.push(trackingDenied
      ? 'mail.tracking.value: access denied — requires Administration/Settings group in Odoo'
      : 'mail.tracking.value: not extracted');
  }

  const valuationTotal = m05?.stock?.valuation_total;
  const svlCount = counts05['stock.valuation.layer'] || 0;
  if (svlCount > 0 && valuationTotal != null && Math.abs(Number(valuationTotal)) > 0.01) {
    gaps.push(`stock.valuation.layer: extracted (${svlCount} rows, valuation_total=${valuationTotal})`);
  } else if (svlCount > 0) {
    gaps.push(`stock.valuation.layer: extracted (${svlCount} rows) but valuation_total=${valuationTotal ?? 0} — check product costing method`);
  } else {
    gaps.push('stock.valuation.layer: not extracted');
  }

  if (extracted.has('account.full.reconcile')) {
    gaps.push('account.full.reconcile: exported all-time reconciliation history — not FY-scoped; do not read counts as FY figures');
  }

  const neverExtracted = ['account.analytic.line', 'hr.payslip'];
  for (const model of neverExtracted) {
    if (!extracted.has(model)) {
      const note = model === 'hr.payslip'
        ? 'payroll source documents unavailable (journal entries present in ledger)'
        : 'cost allocation details unavailable';
      gaps.push(`${model}: not extracted — ${note}`);
    }
  }

  for (const err of apiErrors) {
    if (err.status === 'access_denied' || err.error_type === 'access_denied') {
      gaps.push(`${err.model || 'unknown'}: access denied during extraction (${err.stage})`);
    }
  }

  return [...new Set(gaps)];
}

function buildRawDataPointer(snapshotRoot, statusOverride) {
  const modelCount = countRawJsonlFiles(snapshotRoot);
  const rawPushPack = safeJson(path.join(snapshotRoot, '06_raw_github_push/manifests/raw_push_stage_pack.json'));
  let status = statusOverride || 'pending';
  if (rawPushPack?.status === 'success') status = 'complete';
  if (rawPushPack?.status === 'error') status = 'failed';

  return {
    status,
    repo_path: `raw_data/${snapshotId}/`,
    repo_url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${GITHUB_BRANCH}/raw_data/${snapshotId}/`,
    model_count: rawPushPack?.files_pushed ?? (status === 'complete' ? modelCount : null),
    total_rows: rawPushPack?.total_rows ?? null,
    note: 'Byte-for-byte Odoo API output. Private repo. Not sanitised. Use for row-level forensic recomputation.',
  };
}

// ── Collect files to push ──────────────────────────────────────────────────────
function collectFile(localPath, repoRelPath) {
  if (!fs.existsSync(localPath)) return null;
  return { localPath, repoPath: `${repoPrefix}/${repoRelPath}` };
}

// ── Build structured audit_payload.json ───────────────────────────────────────
function buildAuditPayload() {
  function safe(p) { return safeJson(p); }
  function r2(v) { return Math.round((Number(v)||0)*100)/100; }

  const scope = loadSnapshotScope(snapshotRoot);
  const lateWriteCutoff = addDaysIso(scope.fy_end, 62); // ~2 months after FY end

  const m01 = safe(path.join(snapshotRoot, '01_account_ledger/metrics/account_ledger_metric_pack.json'));
  const a01 = safe(path.join(snapshotRoot, '01_account_ledger/anomalies/account_ledger_anomaly_pack.json'));
  const m02 = safe(path.join(snapshotRoot, '02_pos_retail/metrics/pos_retail_metric_pack.json'));
  const a02 = safe(path.join(snapshotRoot, '02_pos_retail/anomalies/pos_retail_anomaly_pack.json'));
  const m05 = safe(path.join(snapshotRoot, '05_master_data/metrics/master_data_metric_pack.json'));
  const a05 = safe(path.join(snapshotRoot, '05_master_data/anomalies/master_data_anomaly_pack.json'));
  const ready = safe(path.join(snapshotRoot, '03_sanitise_profile/manifests/claude_readiness_summary.json'));

  return {
    _schema: 'ghoststack-audit-orientation/v2',
    snapshot_id: snapshotId,
    generated_at: new Date().toISOString(),
    scope,
    mcp_server: {
      endpoint: 'https://workflow.rideai.com.au/webhook/odoo-eofy-forensic-mcp-v3',
      auth: 'Bearer token — provided separately',
      entry_tool: 'odoo_audit_init — call first to initialise session with live snapshot context',
      primary_query_tool: 'odoo_query — filter any model by any field with full pagination',
      tools_count: 25,
    },
    readiness_summary: ready ? {
      overall_status: ready.readiness_status || ready.overall_status || 'ready',
      sanitised_models: ready.sanitised_model_count || null,
      pii_fields_removed: ready.pii_fields_removed || null,
      audit_blockers: ready.audit_blockers || [],
      warnings: ready.warnings || [],
    } : { overall_status: 'unknown' },
    stages: {
      stage_01_account_ledger: m01 ? {
        status: 'complete',
        ledger: {
          total_debit: r2(m01.ledger?.total_debit),
          total_credit: r2(m01.ledger?.total_credit),
          net_balance: r2(m01.ledger?.net_balance),
          balanced: Math.abs(r2(m01.ledger?.net_balance)) < 0.01,
          account_count: Object.keys(m01.ledger?.by_account || {}).length,
          months_covered: Object.keys(m01.ledger?.by_month || {}).sort(),
        },
        moves: m01.moves || {},
        reconciliation: m01.reconciliation || {},
        anomalies: {
          total: a01?.total_anomalies || 0,
          types: a01?.anomaly_counts || {},
          sample_10: (a01?.anomalies || []).slice(0, 10),
          note: 'line_modified_after_period_end (37k) is a known mass Odoo operation after FY close — low severity unless tied to specific entries. Focus on non_posted_move_line_in_period for material risk.',
        },
      } : { status: 'missing' },
      stage_02_pos_retail: m02 ? {
        status: 'complete',
        pos: m02.pos || {},
        integrity: m02.integrity || {},
        anomalies: { total: a02?.total_anomalies || 0, types: a02?.anomaly_counts || {}, sample_10: (a02?.anomalies || []).slice(0, 10) },
      } : { status: 'missing' },
      stage_03_sanitise: ready ? { status: 'complete', sanitised_model_count: ready.sanitised_model_count || null, readiness_status: ready.readiness_status || ready.overall_status || null } : { status: 'missing' },
      stage_05_master_data: m05 ? {
        status: 'complete',
        model_counts: m05.model_counts || {},
        totals: {
          total_records: m05.model_counts ? Object.values(m05.model_counts).reduce((a, b) => a + b, 0) : null,
          partners: m05.model_counts?.['res.partner'] || 0,
          products: m05.model_counts?.['product.product'] || 0,
          stock_moves: m05.model_counts?.['stock.move'] || 0,
          sale_orders: m05.model_counts?.['sale.order'] || 0,
          purchase_orders: m05.model_counts?.['purchase.order'] || 0,
          attachments: m05.model_counts?.['ir.attachment'] || 0,
        },
        stock: m05.stock || {},
        attachment_by_model: m05.attachment?.count_by_res_model || {},
        cross_ref: m05.cross_ref || {},
        anomalies: { total: a05?.total_anomalies || 0, types: a05?.anomaly_counts || {}, sample_10: (a05?.anomalies || []).slice(0, 10) },
      } : { status: 'missing — Stage 05 did not complete before GitHub push' },
    },
    audit_test_battery: [
      { id: 'T01', area: 'Ledger integrity',    test: 'Verify total_debit == total_credit.', result: m01 ? (Math.abs(r2(m01.ledger?.net_balance)) < 0.01 ? 'PASS' : 'FAIL') : 'UNKNOWN' },
      { id: 'T02', area: 'Unreconciled AR',      test: 'Count unreconciled receivable lines > 0 balance.', tool: 'odoo_unreconciled' },
      { id: 'T03', area: 'Unreconciled AP',      test: 'Count unreconciled payable lines > 0 balance.', tool: 'odoo_unreconciled' },
      { id: 'T04', area: 'Unposted moves in FY', test: 'Find account.move with state != posted and date in FY range.', tool: 'odoo_query', risk: 'Revenue recognition gap' },
      { id: 'T05', area: 'Stock valuation',      test: 'Verify stock.valuation.layer closing balance matches inventory account (630).', tool: 'odoo_query + odoo_precomputed_metrics' },
      { id: 'T06', area: 'GST reconciliation',   test: 'Sum tax lines on posted invoices vs account.tax reported totals.', tool: 'odoo_aggregate on account.move.line' },
      { id: 'T07', area: 'POS vs ledger',        test: 'Sum POS payments by journal and compare to journal entries.', tool: 'odoo_pos_integrity + odoo_query' },
      { id: 'T08', area: 'Unbilled revenue',     test: 'Find sale.order with invoice_status=to invoice at FY end.', tool: 'odoo_query on sale.order' },
      { id: 'T09', area: 'Accrued payables',     test: 'Find purchase.order with billing_status=to bill at FY end.', tool: 'odoo_query on purchase.order' },
      { id: 'T10', area: 'Late journal entries', test: `Identify account.move with date <= ${scope.fy_end} but write_date > ${lateWriteCutoff}.`, tool: 'odoo_late_writes' },
      { id: 'T11', area: 'Negative stock',       test: 'Find product.product with qty_available < 0.', tool: 'odoo_query on product.product' },
      { id: 'T12', area: 'Top customer balances', test: 'Top 20 customer outstanding balances from AR account group.', tool: 'odoo_query on account.move.line' },
    ],
    extraction_gaps: buildExtractionGaps(snapshotRoot, m05),
    raw_data: buildRawDataPointer(snapshotRoot),
    how_to_use: {
      step1: 'Call odoo_audit_init via MCP for live snapshot context, field index, and anomaly leads',
      step2: 'Run audit_test_battery tests T01-T12 using odoo_query, odoo_aggregate, odoo_precomputed_* tools',
      step3: 'Use odoo_schema to check field availability before querying any model',
      step4: 'Cross-reference stock.move ↔ account.move.line for COGS validation',
      step5: 'Flag discrepancies with specific record IDs and amounts — do not generalise from sample',
      step6: `Download raw JSONL from raw_data/${snapshotId}/ on GitHub for independent row-level recomputation (trial balance, AP aging, bank rec)`,
    },
  };
}

const filesToPush = [
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

  // Build and write structured audit_payload.json (replaces raw Anthropic API body)
  const auditPayloadPath = '/tmp/odoo_04_audit_payload.json';
  const auditPayload = buildAuditPayload();
  fs.writeFileSync(auditPayloadPath, JSON.stringify(auditPayload, null, 2), 'utf8');
  filesToPush.unshift({ localPath: auditPayloadPath, repoPath: `${repoPrefix}/audit_payload.json` });

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
