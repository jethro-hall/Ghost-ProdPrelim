/**
 * ODOO EOFY MCP DATA SERVER — BRISBANE FORENSIC AUDIT v3.0
 *
 * Designed for Claude Opus. Forensic export paths, pre-computed packs,
 * token-efficient aggregated tools, and streaming pagination for large models.
 *
 * Deploy: paste this file as the Code node body in n8n.
 * Set ACCESS_TOKEN before activating.
 * Requires NODE_FUNCTION_ALLOW_BUILTIN=* on n8n service.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const ACCESS_TOKEN = '675620e616cb74f0fb5d2946261de78dffb714c7145aec3d71af3eed9e8e93e3';

const EXPORT_ROOT = '/home/node/.n8n/odoo_forensic_exports';

const SCOPE = {
  company_id: 4,
  company_name: 'Ride Electric Brisbane',
  fy_start: '2024-07-01',
  fy_end: '2025-06-30',
  timezone: 'Australia/Brisbane',
  note: 'Brisbane only. Do not generalise to other Ride Electric entities without explicit evidence.',
};

const FY_END = '2025-06-30';
const LATE_WRITE_THRESHOLD = '2025-07-01';

const MAX_PAGE = 2000;
const DEFAULT_PAGE = 500;
// No hard file-read cap — all rows must be visible to aggregation, schema, and query tools.
// Response-level limits (MAX_PAGE, tool limit args) control what is *returned* to Claude, not what is *scanned*.

// ─── PATH HELPERS ─────────────────────────────────────────────────────────────

function listSnapshots() {
  try {
    return fs.readdirSync(EXPORT_ROOT)
      .filter(n => n.startsWith('eofy_') && !n.startsWith('eofy_.'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function latestSnapshot() {
  const snaps = listSnapshots();
  // prefer snapshots that have 01_account_ledger
  for (const s of snaps) {
    if (fs.existsSync(path.join(EXPORT_ROOT, s, '01_account_ledger', 'raw'))) return s;
  }
  return snaps[0] || null;
}

function snapshotBase(snapshotId) {
  return path.join(EXPORT_ROOT, snapshotId);
}

function stageRawDir(snapshotId, stage) {
  return path.join(snapshotBase(snapshotId), stage, 'raw');
}

function stageSanitisedDir(snapshotId, stage) {
  return path.join(snapshotBase(snapshotId), '03_sanitise_profile', 'sanitised', stage);
}

function stageManifestDir(snapshotId, stage) {
  return path.join(snapshotBase(snapshotId), stage, 'manifests');
}

function sanitiseManifestDir(snapshotId) {
  return path.join(snapshotBase(snapshotId), '03_sanitise_profile', 'manifests');
}

// Return all JSONL files for a snapshot, preferring sanitised over raw
function snapshotJsonlFiles(snapshotId) {
  const files = [];
  const base = snapshotBase(snapshotId);
  const stages = ['01_account_ledger', '02_pos_retail', '05_master_data'];

  for (const stage of stages) {
    // sanitised preferred
    const sanDir = path.join(base, '03_sanitise_profile', 'sanitised', stage);
    if (fs.existsSync(sanDir)) {
      for (const f of fs.readdirSync(sanDir)) {
        if (f.endsWith('.sanitised.jsonl')) {
          files.push({ file: path.join(sanDir, f), stage, sanitised: true });
        }
      }
      continue;
    }
    // raw fallback
    const rawDir = path.join(base, stage, 'raw');
    if (fs.existsSync(rawDir)) {
      for (const f of fs.readdirSync(rawDir)) {
        if (f.endsWith('.jsonl')) {
          files.push({ file: path.join(rawDir, f), stage, sanitised: false });
        }
      }
    }
  }
  return files;
}

// Infer dotted model name from file path
function inferModel(filePath) {
  const base = path.basename(filePath);
  return base.replace(/\.sanitised\.jsonl$/, '').replace(/\.jsonl$/, '');
}

// Normalise dotted or underscored model name to dotted form
function dotModel(m) {
  return String(m || '').trim();
}

// Find the JSONL file for a model in a snapshot
function findModelFile(snapshotId, model) {
  const dot = dotModel(model).toLowerCase();
  const under = dot.replace(/\./g, '_');
  for (const entry of snapshotJsonlFiles(snapshotId)) {
    const m = inferModel(entry.file).toLowerCase();
    if (m === dot || m === under) return entry;
  }
  return null;
}

// ─── JSONL READER ────────────────────────────────────────────────────────────

function readJsonl(filePath, opts = {}) {
  const limit = opts.limit ?? Infinity;
  const offset = opts.offset ?? 0;
  const filter = opts.filter; // (row) => bool — applied before limit/offset

  const rows = [];
  let parsed = 0;
  let matched = 0;
  let errors = 0;
  let truncated = false;
  let file_rows = 0; // total lines in file (for reporting)

  let text;
  try {
    // Always read the full file — no byte cap.
    // The 40MB buffer that existed before silently dropped 35-55% of rows in large models.
    // Response-level limits in each tool control what is returned to Claude.
    text = fs.readFileSync(filePath, 'utf8');
    file_rows = text.split('\n').length; // rough line count
  } catch {
    return { rows, parsed, matched, errors: 1, truncated: false, file_rows: 0 };
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    parsed++;
    let obj;
    try { obj = JSON.parse(line); } catch { errors++; continue; }
    if (filter && !filter(obj)) continue;
    matched++;
    if (matched <= offset) continue;
    if (rows.length >= limit) { truncated = true; break; }
    rows.push(obj);
  }

  return { rows, parsed, matched, errors, truncated, file_rows };
}

// ─── PRE-COMPUTED PACK READERS ────────────────────────────────────────────────

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function loadStagePack(snapshotId, stage) {
  const packName = stage === '01_account_ledger' ? 'account_ledger_stage_pack.json'
    : stage === '02_pos_retail' ? 'pos_retail_stage_pack.json' : null;
  if (!packName) return null;
  return readJson(path.join(stageManifestDir(snapshotId, stage), packName));
}

function loadMetricPack(snapshotId, stage) {
  const dir = path.join(snapshotBase(snapshotId), stage, 'metrics');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('_metric_pack.json')) : [];
  if (!files.length) return null;
  return readJson(path.join(dir, files[0]));
}

function loadAnomalyPack(snapshotId, stage) {
  const dir = path.join(snapshotBase(snapshotId), stage, 'anomalies');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('_anomaly_pack.json')) : [];
  if (!files.length) return null;
  return readJson(path.join(dir, files[0]));
}

function loadSubworkflowResult(snapshotId, stage) {
  return readJson(path.join(stageManifestDir(snapshotId, stage), 'subworkflow_result.json'));
}

function loadApiErrors(snapshotId, stage) {
  return readJson(path.join(stageManifestDir(snapshotId, stage), 'api_errors.json')) || [];
}

function loadReadinessSummary(snapshotId) {
  return readJson(path.join(sanitiseManifestDir(snapshotId), 'claude_readiness_summary.json'));
}

// ─── AGGREGATE HELPERS ────────────────────────────────────────────────────────

// Round to 2dp
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Compute monthly debit/credit/balance from account.move.line rows
function monthlyLedger(rows) {
  const by = {};
  for (const row of rows) {
    const m = String(row.date || row.write_date || '').slice(0, 7) || 'unknown';
    if (!by[m]) by[m] = { debit: 0, credit: 0, balance: 0, lines: 0 };
    by[m].debit += Number(row.debit) || 0;
    by[m].credit += Number(row.credit) || 0;
    by[m].balance += Number(row.balance) || 0;
    by[m].lines++;
  }
  for (const v of Object.values(by)) { v.debit = r2(v.debit); v.credit = r2(v.credit); v.balance = r2(v.balance); }
  return Object.fromEntries(Object.entries(by).sort());
}

// Detect journal entry balance anomalies (debit != credit per move_id)
function unbalancedMoves(rows) {
  const byMove = {};
  for (const row of rows) {
    const mid = row.move_id_id || row.move_id;
    if (!mid) continue;
    if (!byMove[mid]) byMove[mid] = { move_id: mid, debit: 0, credit: 0 };
    byMove[mid].debit += Number(row.debit) || 0;
    byMove[mid].credit += Number(row.credit) || 0;
  }
  return Object.values(byMove)
    .filter(m => Math.abs(r2(m.debit) - r2(m.credit)) > 0.01)
    .map(m => ({ ...m, debit: r2(m.debit), credit: r2(m.credit), diff: r2(m.debit - m.credit) }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

// Lines modified after FY end
function lateWrites(rows, threshold = LATE_WRITE_THRESHOLD) {
  return rows
    .filter(r => r.write_date && String(r.write_date) >= threshold)
    .map(r => ({
      id: r.id,
      write_date: r.write_date,
      date: r.date || r.invoice_date || null,
      balance: r.balance ?? r.amount_total ?? null,
      move_id: r.move_id_id || r.move_id || null,
      account_id: r.account_id_id || r.account_id || null,
      journal_id: r.journal_id_id || r.journal_id || null,
      write_uid: r.write_uid_id || r.write_uid || null,
    }))
    .sort((a, b) => String(b.write_date).localeCompare(String(a.write_date)));
}

// POS order vs amount_paid mismatch
function posMismatch(rows) {
  return rows
    .filter(r => {
      const diff = Math.abs((Number(r.amount_total) || 0) - (Number(r.amount_paid) || 0));
      return diff > 0.01 && r.state !== 'cancel';
    })
    .map(r => ({
      id: r.id,
      name: r.name,
      state: r.state,
      amount_total: r2(r.amount_total),
      amount_paid: r2(r.amount_paid),
      diff: r2(Math.abs((Number(r.amount_total) || 0) - (Number(r.amount_paid) || 0))),
      date_order: r.date_order,
      config_id: r.config_id_id || r.config_id || null,
      write_uid: r.write_uid_id || r.write_uid || null,
    }))
    .sort((a, b) => b.diff - a.diff);
}

// POS orders without linked account.move
function posWithoutMove(rows) {
  return rows
    .filter(r => r.state === 'done' && (!r.account_move || r.account_move === false))
    .map(r => ({
      id: r.id,
      name: r.name,
      state: r.state,
      amount_total: r2(r.amount_total),
      date_order: r.date_order,
      config_id: r.config_id_id || r.config_id || null,
    }))
    .sort((a, b) => String(b.date_order).localeCompare(String(a.date_order)));
}

// POS monthly totals
function posMonthly(rows) {
  const by = {};
  for (const row of rows) {
    const m = String(row.date_order || '').slice(0, 7) || 'unknown';
    if (!by[m]) by[m] = { orders: 0, amount_total: 0, amount_paid: 0, amount_return: 0, refunds: 0 };
    by[m].orders++;
    by[m].amount_total += Number(row.amount_total) || 0;
    by[m].amount_paid += Number(row.amount_paid) || 0;
    by[m].amount_return += Number(row.amount_return) || 0;
    if ((Number(row.amount_total) || 0) < 0) by[m].refunds++;
  }
  for (const v of Object.values(by)) {
    v.amount_total = r2(v.amount_total);
    v.amount_paid = r2(v.amount_paid);
    v.amount_return = r2(v.amount_return);
  }
  return Object.fromEntries(Object.entries(by).sort());
}

// Unreconciled receivable/payable from account.move.line
function unreconciledLines(rows) {
  return rows
    .filter(r => {
      const acType = r.account_id_label || '';
      const isReceivable = acType.toLowerCase().includes('receivable') || (r.account_id_id && [533].includes(Number(r.account_id_id)));
      const isPayable = acType.toLowerCase().includes('payable');
      return (isReceivable || isPayable) && !r.reconciled && Math.abs(Number(r.balance) || 0) > 0.01;
    })
    .map(r => ({
      id: r.id,
      account_id: r.account_id_id,
      account: r.account_id_label,
      partner_id: r.partner_id_id || null,
      balance: r2(r.balance),
      date: r.date,
      move_id: r.move_id_id || r.move_id,
      payment_state: r.payment_state || null,
    }))
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
}

// ─── SNAPSHOT CATALOGUE ───────────────────────────────────────────────────────

function snapshotCatalogue(snapshotId) {
  const stages = ['01_account_ledger', '02_pos_retail', '05_master_data'];
  const out = { snapshot_id: snapshotId, models: [], extraction_gaps: [], stage_statuses: [] };

  for (const stage of stages) {
    const result = loadSubworkflowResult(snapshotId, stage);
    const apiErrors = loadApiErrors(snapshotId, stage);
    if (result) {
      out.stage_statuses.push({
        stage,
        status: result.status,
        models_exported: result.models_exported || [],
        models_attempted: result.models_attempted || [],
      });
    }
    for (const e of apiErrors) {
      out.extraction_gaps.push({ stage, model: e.model, error: String(e.error || '').split('\n')[0] });
    }

    // files available
    const rawDir = stageRawDir(snapshotId, stage);
    const sanDir = stageSanitisedDir(snapshotId, stage);
    const useDir = fs.existsSync(sanDir) ? sanDir : (fs.existsSync(rawDir) ? rawDir : null);
    if (!useDir) continue;

    for (const f of fs.readdirSync(useDir).sort()) {
      if (!f.endsWith('.jsonl')) continue;
      const model = f.replace(/\.sanitised\.jsonl$/, '').replace(/\.jsonl$/, '');
      const filePath = path.join(useDir, f);
      let st;
      try { st = fs.statSync(filePath); } catch { continue; }
      // count lines quickly
      let lines = 0;
      try {
        const buf = fs.readFileSync(filePath, 'utf8');
        for (let i = 0; i < buf.length; i++) if (buf[i] === '\n') lines++;
      } catch { lines = -1; }
      out.models.push({
        model,
        stage,
        sanitised: f.includes('.sanitised.'),
        rows: lines,
        bytes: st.size,
        file: f,
      });
    }
  }

  return out;
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────

function authOk(input) {
  const headers = input.headers || {};
  const query = input.query || {};
  const bearer = headers.authorization || headers.Authorization || '';
  const token = String(bearer).startsWith('Bearer ') ? String(bearer).slice(7) : '';
  return token === ACCESS_TOKEN || (query.token || '') === ACCESS_TOKEN;
}

// ─── MCP RESPONSE HELPERS ─────────────────────────────────────────────────────

function ok(data) { return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }], isError: false }; }
function rpcOk(id, result) { return { jsonrpc: '2.0', id: id ?? null, result }; }
function rpcErr(id, code, msg, data = {}) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message: msg, data } }; }

// ─── TOOL IMPLEMENTATIONS ─────────────────────────────────────────────────────

function toolSnapshotList() {
  const snaps = listSnapshots();
  const latest = latestSnapshot();
  return {
    ok: true,
    latest_snapshot: latest,
    snapshots: snaps.map(s => {
      const hasLedger = fs.existsSync(path.join(EXPORT_ROOT, s, '01_account_ledger', 'raw'));
      const hasPOS = fs.existsSync(path.join(EXPORT_ROOT, s, '02_pos_retail', 'raw'));
      const hasMasterData = fs.existsSync(path.join(EXPORT_ROOT, s, '05_master_data', 'raw'));
      const hasSanitised = fs.existsSync(path.join(EXPORT_ROOT, s, '03_sanitise_profile', 'sanitised'));
      const hasAuditReport = fs.existsSync(path.join(EXPORT_ROOT, s, '04_claude_audit', 'manifests', 'claude_anomaly_report.json'));
      return { snapshot_id: s, has_ledger: hasLedger, has_pos: hasPOS, has_master_data: hasMasterData, has_sanitised: hasSanitised, has_audit_report: hasAuditReport };
    }),
  };
}

function toolCatalogue(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  if (!snapshotId) return { ok: false, error: 'No snapshots found in ' + EXPORT_ROOT };
  const cat = snapshotCatalogue(snapshotId);
  const readiness = loadReadinessSummary(snapshotId);
  const ledgerMetrics = loadMetricPack(snapshotId, '01_account_ledger');
  const posMetrics = loadMetricPack(snapshotId, '02_pos_retail');
  const masterDataMetrics = loadMetricPack(snapshotId, '05_master_data');

  return {
    ok: true,
    snapshot_id: snapshotId,
    scope: SCOPE,
    catalogue: cat,
    readiness_summary: readiness?.summary || null,
    extraction_gaps: cat.extraction_gaps,
    pre_computed_packs: {
      ledger_metrics_available: !!ledgerMetrics,
      pos_metrics_available: !!posMetrics,
      master_data_metrics_available: !!masterDataMetrics,
      ledger_anomaly_pack_available: !!loadAnomalyPack(snapshotId, '01_account_ledger'),
      pos_anomaly_pack_available: !!loadAnomalyPack(snapshotId, '02_pos_retail'),
      master_data_anomaly_pack_available: !!loadAnomalyPack(snapshotId, '05_master_data'),
    },
    tool_hint: 'Use odoo_precomputed_metrics and odoo_precomputed_anomalies first to avoid reading raw rows. Fall back to odoo_model_rows for targeted record retrieval.',
  };
}

function toolPrecomputedMetrics(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const stage = args.stage || 'all';
  const out = { ok: true, snapshot_id: snapshotId, scope: SCOPE };

  if (stage === 'all' || stage === '01_account_ledger') {
    out.ledger = loadMetricPack(snapshotId, '01_account_ledger');
  }
  if (stage === 'all' || stage === '02_pos_retail') {
    out.pos = loadMetricPack(snapshotId, '02_pos_retail');
  }
  if (stage === 'all' || stage === '05_master_data') {
    out.master_data = loadMetricPack(snapshotId, '05_master_data');
  }

  return out;
}

function toolPrecomputedAnomalies(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const stage = args.stage || 'all';
  const limit = Math.min(Number(args.limit || 200), 1000);
  const severity = args.severity || null;
  const out = { ok: true, snapshot_id: snapshotId };

  function filterAnoms(pack) {
    if (!pack) return null;
    const anoms = (pack.anomalies || []).filter(a => !severity || a.severity === severity).slice(0, limit);
    return {
      anomaly_counts: pack.anomaly_counts || {},
      blocked_metrics: pack.blocked_metrics || [],
      total_anomalies: (pack.anomalies || []).length,
      returned: anoms.length,
      anomalies: anoms,
    };
  }

  if (stage === 'all' || stage === '01_account_ledger') {
    out.ledger = filterAnoms(loadAnomalyPack(snapshotId, '01_account_ledger'));
  }
  if (stage === 'all' || stage === '02_pos_retail') {
    out.pos = filterAnoms(loadAnomalyPack(snapshotId, '02_pos_retail'));
  }
  if (stage === 'all' || stage === '05_master_data') {
    out.master_data = filterAnoms(loadAnomalyPack(snapshotId, '05_master_data'));
  }

  return out;
}

function toolModelRows(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const model = args.model;
  const offset = Number(args.offset || 0);
  const limit = Math.min(Number(args.limit || DEFAULT_PAGE), MAX_PAGE);
  const fields = args.fields || null; // null = all; array = only these

  if (!model) return { ok: false, error: 'model is required' };

  const entry = findModelFile(snapshotId, model);
  if (!entry) {
    return { ok: false, error: `Model '${model}' not found in snapshot '${snapshotId}'. Check odoo_catalogue first.`, snapshot_id: snapshotId };
  }

  const res = readJsonl(entry.file, { offset, limit });

  let rows = res.rows;
  if (fields && Array.isArray(fields) && fields.length) {
    rows = rows.map(r => {
      const out = {};
      for (const f of fields) if (f in r) out[f] = r[f];
      return out;
    });
  }

  return {
    ok: true,
    snapshot_id: snapshotId,
    model,
    sanitised: entry.sanitised,
    stage: entry.stage,
    offset,
    limit,
    returned: rows.length,
    total_matched: res.matched,
    file_truncated: res.truncated,
    parse_errors: res.errors,
    rows,
  };
}

function toolLateWrites(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const model = args.model || 'account.move.line';
  const threshold = args.threshold || LATE_WRITE_THRESHOLD;
  const limit = Math.min(Number(args.limit || 500), 2000);

  const entry = findModelFile(snapshotId, model);
  if (!entry) return { ok: false, error: `Model '${model}' not found` };

  const res = readJsonl(entry.file, {
    filter: r => r.write_date && String(r.write_date) >= threshold,
    limit,
  });

  return {
    ok: true,
    snapshot_id: snapshotId,
    model,
    threshold,
    returned: res.rows.length,
    late_write_rows: lateWrites(res.rows, threshold),
    note: `Rows where write_date >= ${threshold} (after FY end ${FY_END})`,
  };
}

function toolLedgerIntegrity(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();

  // use pre-computed pack if available
  const metrics = loadMetricPack(snapshotId, '01_account_ledger');
  if (metrics) {
    return {
      ok: true,
      snapshot_id: snapshotId,
      source: 'pre_computed_metric_pack',
      ledger_totals: { debit: r2(metrics.ledger.total_debit), credit: r2(metrics.ledger.total_credit), net_balance: r2(metrics.ledger.net_balance) },
      moves: metrics.moves,
      reconciliation: metrics.reconciliation,
      by_month: metrics.ledger.by_month,
      trial_balance_accounts: metrics.ledger.trial_balance_accounts || null,
      note: 'Pre-computed by exporter. Use odoo_model_rows(account.move.line) for row-level investigation.',
    };
  }

  // fallback: compute from raw file
  const entry = findModelFile(snapshotId, 'account.move.line');
  if (!entry) return { ok: false, error: 'account.move.line not available' };
  const res = readJsonl(entry.file);
  const unbalanced = unbalancedMoves(res.rows);
  const monthly = monthlyLedger(res.rows);
  return {
    ok: true,
    snapshot_id: snapshotId,
    source: 'computed_from_rows',
    total_lines: res.rows.length,
    unbalanced_moves: { count: unbalanced.length, sample: unbalanced.slice(0, 50) },
    by_month: monthly,
  };
}

function toolPOSIntegrity(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const metrics = loadMetricPack(snapshotId, '02_pos_retail');
  if (metrics) {
    return {
      ok: true,
      snapshot_id: snapshotId,
      source: 'pre_computed_metric_pack',
      pos_totals: metrics.pos,
      integrity: metrics.integrity,
      blocked_by_missing_models: loadAnomalyPack(snapshotId, '02_pos_retail')?.blocked_metrics || [],
      note: 'Pre-computed by exporter. pos.order.line and pos.payment are absent pending Odoo permissions.',
    };
  }

  const entry = findModelFile(snapshotId, 'pos.order');
  if (!entry) return { ok: false, error: 'pos.order not available' };
  const res = readJsonl(entry.file);
  return {
    ok: true,
    snapshot_id: snapshotId,
    source: 'computed_from_rows',
    orders: res.rows.length,
    amount_total: r2(res.rows.reduce((s, r) => s + (Number(r.amount_total) || 0), 0)),
    amount_paid: r2(res.rows.reduce((s, r) => s + (Number(r.amount_paid) || 0), 0)),
    mismatch_orders: posMismatch(res.rows).slice(0, 100),
    orders_without_account_move: posWithoutMove(res.rows).slice(0, 100),
    by_month: posMonthly(res.rows),
  };
}

function toolUnreconciledBalance(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const entry = findModelFile(snapshotId, 'account.move.line');
  if (!entry) return { ok: false, error: 'account.move.line not available' };

  const res = readJsonl(entry.file, {
    filter: r => !r.reconciled && Math.abs(Number(r.balance) || 0) > 0.01,
    limit: 5000,
  });

  const lines = unreconciledLines(res.rows);
  const totalBal = r2(lines.reduce((s, r) => s + r.balance, 0));
  const byAccount = {};
  for (const l of lines) {
    const k = String(l.account_id);
    if (!byAccount[k]) byAccount[k] = { account_id: l.account_id, account: l.account, balance: 0, count: 0 };
    byAccount[k].balance += l.balance;
    byAccount[k].count++;
  }

  return {
    ok: true,
    snapshot_id: snapshotId,
    total_unreconciled_lines: lines.length,
    total_balance: totalBal,
    by_account: Object.values(byAccount).map(a => ({ ...a, balance: r2(a.balance) })).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)),
    top_records: lines.slice(0, 100),
    note: 'Filtered to account.move.line where reconciled=false and |balance|>0.01',
  };
}

function toolAggregateMonthly(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const metrics = loadMetricPack(snapshotId, '01_account_ledger');
  const posMetrics = loadMetricPack(snapshotId, '02_pos_retail');

  return {
    ok: true,
    snapshot_id: snapshotId,
    scope: SCOPE,
    ledger_by_month: metrics?.ledger?.by_month || null,
    pos_by_month: posMetrics?.pos?.by_month || null,
    note: 'Pre-computed monthly aggregates. Use odoo_ledger_integrity or odoo_model_rows for detail.',
  };
}

function toolSearchRows(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const model = args.model;
  const query = String(args.query || '').toLowerCase();
  const limit = Math.min(Number(args.limit || 100), 500);

  if (!query) return { ok: false, error: 'query is required' };

  const targets = model
    ? [findModelFile(snapshotId, model)].filter(Boolean)
    : snapshotJsonlFiles(snapshotId);

  const hits = [];
  let scanned = 0;
  let errors = 0;

  for (const entry of targets) {
    if (hits.length >= limit) break;
    const res = readJsonl(entry.file, {
      filter: row => JSON.stringify(row).toLowerCase().includes(query),
      limit: limit - hits.length,
    });
    errors += res.errors;
    scanned += res.parsed;
    hits.push(...res.rows);
  }

  return { ok: true, snapshot_id: snapshotId, query, model: model || 'all', scanned, returned: hits.length, errors, rows: hits };
}

function toolRecordById(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const model = args.model;
  const id = String(args.id);
  if (!model || !id) return { ok: false, error: 'model and id are required' };

  const entry = findModelFile(snapshotId, model);
  if (!entry) return { ok: false, error: `Model '${model}' not in snapshot` };

  const res = readJsonl(entry.file, {
    filter: r => String(r.id) === id || String(r.odoo_id) === id,
    limit: 10,
  });

  return { ok: true, snapshot_id: snapshotId, model, id, found: res.rows.length, rows: res.rows };
}

function toolExtractionStatus(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const stages = ['01_account_ledger', '02_pos_retail', '05_master_data'];
  const out = { ok: true, snapshot_id: snapshotId, stages: [] };

  for (const stage of stages) {
    const result = loadSubworkflowResult(snapshotId, stage);
    const apiErrors = loadApiErrors(snapshotId, stage);
    const stagePack = loadStagePack(snapshotId, stage);
    out.stages.push({
      stage,
      status: result?.status || 'unknown',
      models_exported: result?.models_exported || [],
      models_attempted: result?.models_attempted || [],
      records_exported: result?.records_exported || {},
      api_errors: apiErrors.map(e => ({ model: e.model, error: String(e.error || '').split('\n')[0] })),
      extraction_completeness: stagePack?.extraction_completeness || null,
    });
  }

  const readiness = loadReadinessSummary(snapshotId);
  out.readiness = readiness?.summary || null;
  out.extraction_gaps = out.stages.flatMap(s => s.api_errors.map(e => ({ stage: s.stage, ...e })));

  return out;
}

// ─── STRATIFIED SAMPLE ───────────────────────────────────────────────────────
// Returns N rows spread across the full date range of a model so Claude sees
// early, mid, and late FY records rather than just the first N rows.

function toolStratifiedSample(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const model = args.model;
  const n = Math.min(Number(args.n || 50), 500);
  const dateField = args.date_field || null; // auto-detect if null
  const fields = args.fields || null;

  if (!model) return { ok: false, error: 'model is required' };

  const entry = findModelFile(snapshotId, model);
  if (!entry) return { ok: false, error: `Model '${model}' not found in snapshot '${snapshotId}'` };

  // Read all rows (streaming large files)
  const res = readJsonl(entry.file);
  const all = res.rows;
  if (!all.length) {
    return { ok: true, snapshot_id: snapshotId, model, n: 0, total: 0, sample: [] };
  }

  // Detect date field
  const dateFields = ['date', 'invoice_date', 'date_order', 'create_date', 'write_date'];
  const detectedDateField = dateField ||
    dateFields.find(f => all[0] && all[0][f] != null) || null;

  let sorted = all;
  if (detectedDateField) {
    sorted = [...all].sort((a, b) => {
      const da = String(a[detectedDateField] || '');
      const db = String(b[detectedDateField] || '');
      return da.localeCompare(db);
    });
  }

  // Evenly pick n indices across the sorted array
  const sample = [];
  if (sorted.length <= n) {
    sample.push(...sorted);
  } else {
    const step = (sorted.length - 1) / (n - 1);
    for (let i = 0; i < n; i++) {
      sample.push(sorted[Math.round(i * step)]);
    }
  }

  // Apply field projection
  let rows = sample;
  if (fields && Array.isArray(fields) && fields.length) {
    rows = sample.map(r => {
      const out = {};
      for (const f of fields) if (f in r) out[f] = r[f];
      return out;
    });
  }

  const firstDate = detectedDateField ? String(sorted[0][detectedDateField] || '').slice(0, 10) : null;
  const lastDate = detectedDateField ? String(sorted[sorted.length - 1][detectedDateField] || '').slice(0, 10) : null;

  return {
    ok: true,
    snapshot_id: snapshotId,
    model,
    sanitised: entry.sanitised,
    date_field_used: detectedDateField,
    total_rows: all.length,
    sample_n: rows.length,
    date_range: { first: firstDate, last: lastDate },
    sampling_note: `${rows.length} rows evenly distributed across ${all.length} total rows by ${detectedDateField || 'index'}. Represents the full FY date range. This is raw data — form your own conclusions.`,
    rows,
  };
}

// ─── CONTROL TOTAL VERIFY ────────────────────────────────────────────────────
// Gives Claude the pre-computed control totals alongside a sample so it can
// verify the sample is representative and check its own calculations.

function toolControlTotalsWithSample(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const model = args.model || 'account.move.line';
  const sampleN = Math.min(Number(args.sample_n || 50), 200);
  const fields = args.fields || null;

  const entry = findModelFile(snapshotId, model);
  if (!entry) return { ok: false, error: `Model '${model}' not found` };

  const res = readJsonl(entry.file);
  const all = res.rows;

  // Control totals over all rows
  const totals = { rows: all.length, debit: 0, credit: 0, balance: 0, amount_total: 0, quantity: 0 };
  const byMonth = {};
  const byAccount = {};
  const byJournal = {};

  for (const row of all) {
    totals.debit += Number(row.debit) || 0;
    totals.credit += Number(row.credit) || 0;
    totals.balance += Number(row.balance) || 0;
    totals.amount_total += Number(row.amount_total) || 0;
    totals.quantity += Number(row.quantity) || 0;

    const m = String(row.date || row.invoice_date || row.date_order || '').slice(0, 7) || 'unknown';
    if (!byMonth[m]) byMonth[m] = { rows: 0, debit: 0, credit: 0, balance: 0 };
    byMonth[m].rows++;
    byMonth[m].debit += Number(row.debit) || 0;
    byMonth[m].credit += Number(row.credit) || 0;
    byMonth[m].balance += Number(row.balance) || 0;

    const ac = row.account_id_label || row.account_id_id || null;
    if (ac) {
      if (!byAccount[ac]) byAccount[ac] = { rows: 0, balance: 0 };
      byAccount[ac].rows++;
      byAccount[ac].balance += Number(row.balance) || 0;
    }

    const jc = row.journal_id_label || row.journal_id_id || null;
    if (jc) {
      if (!byJournal[jc]) byJournal[jc] = { rows: 0, debit: 0, credit: 0 };
      byJournal[jc].rows++;
      byJournal[jc].debit += Number(row.debit) || 0;
      byJournal[jc].credit += Number(row.credit) || 0;
    }
  }

  // Round totals
  for (const k of Object.keys(totals)) if (typeof totals[k] === 'number') totals[k] = r2(totals[k]);
  for (const v of Object.values(byMonth)) { v.debit = r2(v.debit); v.credit = r2(v.credit); v.balance = r2(v.balance); }
  for (const v of Object.values(byAccount)) v.balance = r2(v.balance);
  for (const v of Object.values(byJournal)) { v.debit = r2(v.debit); v.credit = r2(v.credit); }

  // Stratified sample
  const sampleRes = toolStratifiedSample({ snapshot_id: snapshotId, model, n: sampleN, fields });

  return {
    ok: true,
    snapshot_id: snapshotId,
    model,
    audit_note: 'control_totals cover ALL rows. sample_rows is a stratified slice for your independent analysis. Verify your calculations against control_totals.',
    control_totals: {
      ...totals,
      by_month: Object.fromEntries(Object.entries(byMonth).sort()),
      top_accounts_by_balance: Object.entries(byAccount)
        .sort((a, b) => Math.abs(b[1].balance) - Math.abs(a[1].balance))
        .slice(0, 20)
        .map(([k, v]) => ({ account: k, ...v })),
      by_journal: Object.fromEntries(
        Object.entries(byJournal).sort((a, b) => Math.abs(b[1].debit) - Math.abs(a[1].debit))
      ),
    },
    sample_rows: sampleRes.rows,
    sample_n: sampleRes.sample_n,
    date_range: sampleRes.date_range,
    date_field_used: sampleRes.date_field_used,
  };
}

// ─── FULL MODEL EVIDENCE ─────────────────────────────────────────────────────
// Provides a compact, audit-ready view of all rows for smaller models.
// For large models, returns a dense stratified sample with control totals.

function toolModelEvidence(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const model = args.model;
  const maxRows = Math.min(Number(args.max_rows || 200), 500);
  const fields = args.fields || null;

  if (!model) return { ok: false, error: 'model is required' };

  const entry = findModelFile(snapshotId, model);
  if (!entry) return { ok: false, error: `Model '${model}' not found` };

  const res = readJsonl(entry.file);
  const all = res.rows;
  const isComplete = all.length <= maxRows;

  let rows = isComplete ? all : (() => {
    // Stratified: evenly spaced by date
    const dateField = ['date', 'invoice_date', 'date_order', 'create_date'].find(f => all[0] && all[0][f]);
    const sorted = dateField ? [...all].sort((a, b) => String(a[dateField] || '').localeCompare(String(b[dateField] || ''))) : all;
    const out = [];
    const step = (sorted.length - 1) / (maxRows - 1);
    for (let i = 0; i < maxRows; i++) out.push(sorted[Math.round(i * step)]);
    return out;
  })();

  if (fields && Array.isArray(fields) && fields.length) {
    rows = rows.map(r => { const o = {}; for (const f of fields) if (f in r) o[f] = r[f]; return o; });
  }

  // Compact control totals
  const numericFields = ['debit', 'credit', 'balance', 'amount_total', 'amount_paid', 'amount_return', 'quantity', 'price_total'];
  const sums = {};
  for (const row of all) {
    for (const f of numericFields) {
      if (typeof row[f] === 'number') sums[f] = r2((sums[f] || 0) + row[f]);
    }
  }

  return {
    ok: true,
    snapshot_id: snapshotId,
    model,
    sanitised: entry.sanitised,
    total_rows: all.length,
    returned_rows: rows.length,
    is_complete_dataset: isComplete,
    sampling_note: isComplete
      ? 'Complete dataset — all rows returned.'
      : `Stratified sample of ${maxRows} rows from ${all.length} total. Use odoo_model_rows with offset/limit to page through remaining rows.`,
    control_totals: Object.keys(sums).length ? sums : null,
    rows,
  };
}

// ─── JOURNAL ENTRY DETAIL ────────────────────────────────────────────────────
// Returns all move.lines for one or more move_ids so Claude can inspect
// a complete journal entry — debit side, credit side, tax lines, reconciliation.

function toolJournalEntryDetail(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const moveIds = (args.move_ids || []).map(String);
  const moveName = args.move_name || null;

  if (!moveIds.length && !moveName) return { ok: false, error: 'Provide move_ids[] or move_name.' };

  // Find move.line file
  const lineEntry = findModelFile(snapshotId, 'account.move.line');
  const moveEntry = findModelFile(snapshotId, 'account.move');

  const lines = lineEntry ? readJsonl(lineEntry.file, {
    filter: r => {
      if (moveIds.length && (moveIds.includes(String(r.move_id_id)) || moveIds.includes(String(r.move_id)))) return true;
      if (moveName && (String(r.move_id_label || '').includes(moveName))) return true;
      return false;
    },
    limit: 500,
  }).rows : [];

  // If move_name search, resolve move_ids from lines
  const resolvedIds = new Set(lines.map(l => String(l.move_id_id || l.move_id)).filter(Boolean));
  if (moveIds.length) for (const id of moveIds) resolvedIds.add(id);

  const moves = moveEntry ? readJsonl(moveEntry.file, {
    filter: r => resolvedIds.has(String(r.id)),
    limit: 50,
  }).rows : [];

  // Validate balance per move
  const byMove = {};
  for (const l of lines) {
    const mid = String(l.move_id_id || l.move_id || '');
    if (!byMove[mid]) byMove[mid] = { move_id: mid, debit: 0, credit: 0, lines: 0 };
    byMove[mid].debit += Number(l.debit) || 0;
    byMove[mid].credit += Number(l.credit) || 0;
    byMove[mid].lines++;
  }
  for (const v of Object.values(byMove)) {
    v.debit = r2(v.debit); v.credit = r2(v.credit);
    v.balanced = Math.abs(v.debit - v.credit) < 0.01;
  }

  return {
    ok: true,
    snapshot_id: snapshotId,
    requested_move_ids: moveIds,
    resolved_move_ids: [...resolvedIds],
    moves,
    move_lines: lines,
    line_count: lines.length,
    balance_check: Object.values(byMove),
    audit_note: 'Inspect moves[] for header-level state (payment_state, reversed_entry_id). Inspect move_lines[] for debit/credit allocation. Check balance_check[] for unbalanced entries.',
  };
}

// ─── FLEXIBLE QUERY ENGINE ───────────────────────────────────────────────────
// Gives Claude unrestricted, on-demand access to any model, any field, any filter.
// This is the core "give Claude what it needs, when it needs it" tool.

function applyFilter(row, filter) {
  const { field, op, value } = filter;
  const v = row[field];

  switch (op) {
    case 'eq':  return String(v ?? '') === String(value ?? '');
    case 'ne':  return String(v ?? '') !== String(value ?? '');
    case 'gt':  return Number(v) > Number(value);
    case 'gte': return Number(v) >= Number(value) || String(v) >= String(value);
    case 'lt':  return Number(v) < Number(value);
    case 'lte': return Number(v) <= Number(value) || String(v) <= String(value);
    case 'in':  return Array.isArray(value) && value.map(String).includes(String(v ?? ''));
    case 'not_in': return Array.isArray(value) && !value.map(String).includes(String(v ?? ''));
    case 'contains': return String(v ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'not_contains': return !String(v ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'startswith': return String(v ?? '').toLowerCase().startsWith(String(value ?? '').toLowerCase());
    case 'isnull': return v === null || v === undefined || v === false || v === '';
    case 'notnull': return v !== null && v !== undefined && v !== false && v !== '';
    case 'gt_date': return String(v ?? '') > String(value ?? '');
    case 'gte_date': return String(v ?? '') >= String(value ?? '');
    case 'lt_date': return String(v ?? '') < String(value ?? '');
    case 'lte_date': return String(v ?? '') <= String(value ?? '');
    default: return true;
  }
}

function applyFilters(row, filters) {
  if (!filters || !filters.length) return true;
  return filters.every(f => applyFilter(row, f));
}

function toolQuery(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const model = args.model;
  const filters = args.filters || [];
  const fields = args.fields || null;
  const limit = Math.min(Number(args.limit || 1000), 10000);
  const offset = Number(args.offset || 0);
  const sortBy = args.sort_by || null;
  const sortDir = (args.sort_dir || 'asc').toLowerCase();

  if (!model) return { ok: false, error: 'model is required' };

  const entry = findModelFile(snapshotId, model);
  if (!entry) {
    const available = snapshotJsonlFiles(snapshotId).map(e => inferModel(e.file));
    return { ok: false, error: `Model '${model}' not found.`, available_models: available };
  }

  // Stream with filter applied
  const res = readJsonl(entry.file, { filter: row => applyFilters(row, filters) });
  let rows = res.rows;

  // Sort
  if (sortBy) {
    const dir = sortDir === 'desc' ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const av = a[sortBy] ?? '';
      const bv = b[sortBy] ?? '';
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  const total_matching = rows.length;
  const page = rows.slice(offset, offset + limit);

  // Apply field projection
  let out = page;
  if (fields && Array.isArray(fields) && fields.length) {
    out = page.map(r => { const o = {}; for (const f of fields) if (f in r) o[f] = r[f]; return o; });
  }

  return {
    ok: true,
    snapshot_id: snapshotId,
    model,
    sanitised: entry.sanitised,
    filters_applied: filters,
    total_matching,
    offset,
    limit,
    returned: out.length,
    has_more: offset + limit < total_matching,
    next_offset: offset + limit < total_matching ? offset + limit : null,
    rows: out,
  };
}

// ─── SERVER-SIDE AGGREGATION ─────────────────────────────────────────────────
// GROUP BY any field with COUNT, SUM, MIN, MAX, AVG — without sending raw rows.
// Token cost: constant (returns grouped summary only).

function toolAggregate(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const model = args.model;
  const groupBy = args.group_by || [];   // array of field names
  const metrics = args.metrics || ['count'];  // 'count', 'sum:field', 'min:field', 'max:field', 'avg:field'
  const filters = args.filters || [];
  const limit = Math.min(Number(args.limit || 1000), 5000); // max groups to return
  const sortMetric = args.sort_by || 'count';
  const sortDir = (args.sort_dir || 'desc').toLowerCase();

  if (!model) return { ok: false, error: 'model is required' };

  const entry = findModelFile(snapshotId, model);
  if (!entry) return { ok: false, error: `Model '${model}' not found` };

  const res = readJsonl(entry.file, { filter: row => applyFilters(row, filters) });
  const all = res.rows;

  // Parse metric specs: ['count', 'sum:debit', 'min:date', 'max:write_date', 'avg:balance']
  const metricSpecs = metrics.map(m => {
    const [agg, field] = m.split(':');
    return { agg, field: field || null, key: m };
  });

  // GROUP BY
  const groups = new Map();

  for (const row of all) {
    const key = groupBy.length
      ? groupBy.map(f => String(row[f] ?? '')).join('|||')
      : '__all__';

    if (!groups.has(key)) {
      const gv = {};
      for (const f of groupBy) gv[f] = row[f] ?? null;
      const acc = { __group: gv, __count: 0, __sums: {}, __mins: {}, __maxs: {}, __avgs: {} };
      groups.set(key, acc);
    }

    const acc = groups.get(key);
    acc.__count++;

    for (const spec of metricSpecs) {
      if (!spec.field) continue;
      const v = Number(row[spec.field]);
      if (Number.isFinite(v)) {
        if (spec.agg === 'sum' || spec.agg === 'avg') acc.__sums[spec.field] = (acc.__sums[spec.field] || 0) + v;
        if (spec.agg === 'min') acc.__mins[spec.field] = acc.__mins[spec.field] === undefined ? v : Math.min(acc.__mins[spec.field], v);
        if (spec.agg === 'max') acc.__maxs[spec.field] = acc.__maxs[spec.field] === undefined ? v : Math.max(acc.__maxs[spec.field], v);
      }
      // min/max for string/date fields
      if ((spec.agg === 'min' || spec.agg === 'max') && typeof row[spec.field] === 'string') {
        const sv = String(row[spec.field] || '');
        if (spec.agg === 'min') acc.__mins[spec.field] = !acc.__mins[spec.field] || sv < acc.__mins[spec.field] ? sv : acc.__mins[spec.field];
        if (spec.agg === 'max') acc.__maxs[spec.field] = !acc.__maxs[spec.field] || sv > acc.__maxs[spec.field] ? sv : acc.__maxs[spec.field];
      }
    }
  }

  // Materialise results
  let results = [];
  for (const acc of groups.values()) {
    const row = { ...acc.__group, count: acc.__count };
    for (const spec of metricSpecs) {
      if (spec.agg === 'sum' && spec.field) row[`sum_${spec.field}`] = r2(acc.__sums[spec.field] || 0);
      if (spec.agg === 'avg' && spec.field) row[`avg_${spec.field}`] = acc.__count ? r2((acc.__sums[spec.field] || 0) / acc.__count) : 0;
      if (spec.agg === 'min' && spec.field) row[`min_${spec.field}`] = acc.__mins[spec.field] ?? null;
      if (spec.agg === 'max' && spec.field) row[`max_${spec.field}`] = acc.__maxs[spec.field] ?? null;
    }
    results.push(row);
  }

  // Sort
  const sortKey = sortMetric === 'count' ? 'count'
    : metricSpecs.find(m => m.key === sortMetric || `${m.agg}_${m.field}` === sortMetric)
      ? `${sortMetric.includes(':') ? sortMetric.replace(':', '_') : sortMetric}` : 'count';
  results.sort((a, b) => {
    const av = a[sortKey] ?? 0; const bv = b[sortKey] ?? 0;
    if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'desc' ? bv - av : av - bv;
    return sortDir === 'desc' ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv));
  });

  return {
    ok: true,
    snapshot_id: snapshotId,
    model,
    filters_applied: filters,
    group_by: groupBy,
    metrics,
    total_rows_scanned: all.length,
    total_groups: groups.size,
    returned_groups: Math.min(results.length, limit),
    groups: results.slice(0, limit),
  };
}

// ─── SCHEMA INSPECTION ───────────────────────────────────────────────────────
// Returns field types, completeness, value distributions — Opus can understand
// the data shape before pulling rows.

function toolSchema(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();
  const model = args.model;

  if (!model) {
    // Return all models with basic schema
    const models = snapshotJsonlFiles(snapshotId).map(e => ({
      model: inferModel(e.file),
      stage: e.stage,
      sanitised: e.sanitised,
    }));
    return { ok: true, snapshot_id: snapshotId, models };
  }

  const entry = findModelFile(snapshotId, model);
  if (!entry) return { ok: false, error: `Model '${model}' not found` };

  const res = readJsonl(entry.file);
  const all = res.rows;
  if (!all.length) return { ok: true, snapshot_id: snapshotId, model, rows: 0, fields: [] };

  const fieldStats = {};

  for (const row of all) {
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('_')) continue;
      if (!fieldStats[k]) {
        fieldStats[k] = { field: k, present: 0, null_or_empty: 0, types: new Set(), sample_values: [], numeric_min: null, numeric_max: null, numeric_sum: 0 };
      }
      const s = fieldStats[k];
      s.present++;
      const isEmpty = v === null || v === undefined || v === false || v === '';
      if (isEmpty) s.null_or_empty++;
      const t = Array.isArray(v) ? 'array' : typeof v;
      s.types.add(t);
      if (s.sample_values.length < 5 && !isEmpty) s.sample_values.push(v);
      if (typeof v === 'number') {
        s.numeric_sum += v;
        s.numeric_min = s.numeric_min === null ? v : Math.min(s.numeric_min, v);
        s.numeric_max = s.numeric_max === null ? v : Math.max(s.numeric_max, v);
      }
    }
  }

  const fields = Object.values(fieldStats).map(s => ({
    field: s.field,
    completeness_pct: Math.round((s.present - s.null_or_empty) / all.length * 100),
    present: s.present,
    null_or_empty: s.null_or_empty,
    types: [...s.types].join('|'),
    sample_values: s.sample_values.slice(0, 3).map(v => String(v).slice(0, 80)),
    ...(s.numeric_min !== null ? {
      numeric_min: r2(s.numeric_min),
      numeric_max: r2(s.numeric_max),
      numeric_sum: r2(s.numeric_sum),
    } : {}),
  })).sort((a, b) => a.field.localeCompare(b.field));

  return {
    ok: true,
    snapshot_id: snapshotId,
    model,
    sanitised: entry.sanitised,
    total_rows: all.length,
    fields,
    audit_note: 'Use completeness_pct to understand data quality. Fields with low completeness may indicate extraction gaps or optional Odoo fields.',
  };
}

// ─── AUDIT INIT (OPUS BOOTSTRAP) ─────────────────────────────────────────────
// Returns everything Opus needs to start an independent forensic audit:
// scope, available data, schemas for key models, control totals, anomaly leads.
// Designed to be the FIRST call in an audit session.

function toolAuditInit(args) {
  const snapshotId = args.snapshot_id || latestSnapshot();

  // Available models
  const modelFiles = snapshotJsonlFiles(snapshotId);
  const modelList = modelFiles.map(e => {
    const model = inferModel(e.file);
    try {
      const st = fs.statSync(e.file);
      let lines = 0;
      const buf = fs.readFileSync(e.file, 'utf8');
      for (let i = 0; i < buf.length; i++) if (buf[i] === '\n') lines++;
      return { model, stage: e.stage, sanitised: e.sanitised, rows: lines, bytes: st.size };
    } catch { return { model, stage: e.stage, sanitised: e.sanitised, rows: -1, bytes: -1 }; }
  });

  // Quick schema for key audit models (field list only, not full stats)
  function quickFields(model) {
    const entry = findModelFile(snapshotId, model);
    if (!entry) return null;
    try {
      const first = fs.readFileSync(entry.file, 'utf8').split('\n').find(l => l.trim());
      if (!first) return null;
      const row = JSON.parse(first);
      return Object.keys(row).filter(k => !k.startsWith('_'));
    } catch { return null; }
  }

  // Pre-computed packs summary
  const ledgerMetrics = loadMetricPack(snapshotId, '01_account_ledger');
  const posMetrics = loadMetricPack(snapshotId, '02_pos_retail');
  const masterDataMetrics = loadMetricPack(snapshotId, '05_master_data');
  const ledgerAnomalies = loadAnomalyPack(snapshotId, '01_account_ledger');
  const posAnomalies = loadAnomalyPack(snapshotId, '02_pos_retail');
  const masterDataAnomalies = loadAnomalyPack(snapshotId, '05_master_data');

  const ledgerSummary = ledgerMetrics ? {
    total_debit: r2(ledgerMetrics.ledger.total_debit),
    total_credit: r2(ledgerMetrics.ledger.total_credit),
    net_balance: r2(ledgerMetrics.ledger.net_balance),
    unbalanced_moves: ledgerMetrics.moves?.unbalanced_move_count || 0,
    unreconciled_receivable: ledgerMetrics.reconciliation?.unreconciled_receivable_count,
    unreconciled_receivable_balance: r2(ledgerMetrics.reconciliation?.unreconciled_receivable_balance),
    unreconciled_payable: ledgerMetrics.reconciliation?.unreconciled_payable_count,
    unreconciled_payable_balance: r2(ledgerMetrics.reconciliation?.unreconciled_payable_balance),
    months_covered: ledgerMetrics.ledger.by_month ? Object.keys(ledgerMetrics.ledger.by_month).length : null,
  } : null;

  const posSummary = posMetrics ? {
    order_count: posMetrics.pos?.order_count,
    amount_total: r2(posMetrics.pos?.amount_total),
    amount_paid: r2(posMetrics.pos?.amount_paid),
    order_total_mismatch_count: posMetrics.integrity?.order_total_mismatch_count,
    amount_paid_mismatch_count: posMetrics.integrity?.amount_paid_mismatch_count,
    blocked_by: posAnomalies?.blocked_metrics || [],
  } : null;

  const masterDataSummary = masterDataMetrics ? {
    total_records: masterDataMetrics.model_counts
      ? Object.values(masterDataMetrics.model_counts).reduce((a, b) => a + b, 0) : null,
    model_counts: masterDataMetrics.model_counts || {},
    stock_valuation_total: r2(masterDataMetrics.stock?.valuation_total),
    stock_move_count: masterDataMetrics.stock?.move_count || 0,
    mail_message_count: masterDataMetrics.mail?.message_count_by_model
      ? Object.values(masterDataMetrics.mail.message_count_by_model).reduce((a, b) => a + b, 0) : 0,
    attachment_count: masterDataMetrics.attachment?.count_by_res_model
      ? Object.values(masterDataMetrics.attachment.count_by_res_model).reduce((a, b) => a + b, 0) : 0,
    partner_ids_harvested: masterDataMetrics.cross_ref?.partner_ids_harvested || 0,
    product_ids_harvested: masterDataMetrics.cross_ref?.product_ids_harvested || 0,
    blocked_by: masterDataAnomalies?.blocked_metrics || [],
  } : null;

  return {
    ok: true,
    audit_session_init: true,
    snapshot_id: snapshotId,
    scope: SCOPE,

    available_data: modelList,

    field_index: {
      'account.move': quickFields('account.move'),
      'account.move.line': quickFields('account.move.line'),
      'account.payment': quickFields('account.payment'),
      'pos.order': quickFields('pos.order'),
      'pos.order.line': quickFields('pos.order.line'),
      'pos.payment': quickFields('pos.payment'),
      'account.bank.statement.line': quickFields('account.bank.statement.line'),
      'res.partner': quickFields('res.partner'),
      'product.product': quickFields('product.product'),
      'stock.valuation.layer': quickFields('stock.valuation.layer'),
    },

    orientation: {
      ledger: ledgerSummary,
      pos: posSummary,
      master_data: masterDataSummary,
    },

    anomaly_leads: {
      ledger: ledgerAnomalies ? {
        counts: ledgerAnomalies.anomaly_counts,
        sample: (ledgerAnomalies.anomalies || []).slice(0, 10),
        blocked: ledgerAnomalies.blocked_metrics || [],
      } : null,
      pos: posAnomalies ? {
        counts: posAnomalies.anomaly_counts,
        sample: (posAnomalies.anomalies || []).slice(0, 10),
        blocked: posAnomalies.blocked_metrics || [],
      } : null,
      master_data: masterDataAnomalies ? {
        counts: masterDataAnomalies.anomaly_counts,
        sample: (masterDataAnomalies.anomalies || []).slice(0, 10),
        blocked: masterDataAnomalies.blocked_metrics || [],
      } : null,
    },

    tool_guide: {
      primary_data_access: 'odoo_query — filter any model by any field, sort, paginate. This is your main data retrieval tool.',
      aggregation: 'odoo_aggregate — GROUP BY any field with COUNT/SUM/MIN/MAX. Zero raw row cost.',
      schema: 'odoo_schema — field types, completeness, sample values for any model.',
      drill_down: 'odoo_journal_entry_detail — complete journal entry (header + lines + balance check) by move_id.',
      full_file: 'odoo_bundle_csv — raw unfiltered CSV for any model, paginated up to 10k rows.',
      orientation: 'odoo_precomputed_metrics — pre-built monthly totals, account-level balances, reconciliation counts.',
      leads: 'odoo_precomputed_anomalies — extraction-script-detected signals to investigate (not conclusions).',
    },

    audit_principle: 'You have direct, unrestricted access to all data via odoo_query. Use anomaly_leads as starting hypotheses, not conclusions. Derive your own findings from the raw records.',
  };
}

// ─── CSV BUNDLE LISTING ───────────────────────────────────────────────────────
// Lists or reads the pre-generated compact CSV audit bundles.
// The bundles are generated by generate_audit_csv_bundle.py and are the
// recommended way to give Claude direct access to all raw audit data.

const CSV_BUNDLE_ROOT = path.join(EXPORT_ROOT, 'audit_csv_bundles');

function toolListBundles() {
  if (!fs.existsSync(CSV_BUNDLE_ROOT)) {
    return {
      ok: false,
      error: 'No audit CSV bundles found. Run generate_audit_csv_bundle.py first.',
      generate_cmd: 'python3 /var/llamaindex/ghoststack-rag/scripts/n8n-odoo-brisbane-eofy-audit/generate_audit_csv_bundle.py',
    };
  }

  const bundles = [];
  try {
    for (const f of fs.readdirSync(CSV_BUNDLE_ROOT)) {
      if (!f.endsWith('.zip') || f === 'latest_audit_bundle.zip') continue;
      const fp = path.join(CSV_BUNDLE_ROOT, f);
      const st = fs.statSync(fp);
      bundles.push({ file: f, path: fp, bytes: st.size, mb: Math.round(st.size / 1024 / 1024 * 10) / 10, mtime_utc: st.mtime.toISOString() });
    }
  } catch (e) { /* ignore */ }

  bundles.sort((a, b) => b.mtime_utc.localeCompare(a.mtime_utc));
  const latest = bundles[0] || null;

  return {
    ok: true,
    bundle_dir: CSV_BUNDLE_ROOT,
    latest_bundle: latest,
    all_bundles: bundles,
    usage: [
      'These ZIP bundles contain one compact CSV per Odoo model with audit-critical fields.',
      'Download the latest bundle and upload directly to Claude (claude.ai or Claude Desktop).',
      'account.full.reconcile and account.partial.reconcile are excluded — they are join tables.',
      'MANIFEST.json inside each bundle contains control totals for all rows in every model.',
      'README.txt contains field descriptions and anomaly detection guidance.',
      'Bundle size is ~1.3MB compressed — directly uploadable to claude.ai.',
    ],
  };
}

function toolReadBundleManifest(args) {
  const latest = path.join(CSV_BUNDLE_ROOT, 'latest_audit_bundle.zip');
  if (!fs.existsSync(latest)) {
    return { ok: false, error: 'No bundle found. Run generate_audit_csv_bundle.py first.' };
  }

  // Read MANIFEST.json from inside the zip via node's built-in
  // n8n doesn't have unzip CLI so we read raw bytes and parse
  const buf = fs.readFileSync(latest);

  // Find MANIFEST.json in the zip using a simple ZIP local file header scan
  // ZIP local file header: PK\x03\x04 then 26 bytes then filename length + extra length + data
  function findZipEntry(buf, name) {
    const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    let pos = 0;
    while (pos < buf.length - 30) {
      const idx = buf.indexOf(sig, pos);
      if (idx === -1) break;
      const fnLen = buf.readUInt16LE(idx + 26);
      const extraLen = buf.readUInt16LE(idx + 28);
      const fn = buf.slice(idx + 30, idx + 30 + fnLen).toString('utf8');
      const dataStart = idx + 30 + fnLen + extraLen;
      const compressedSize = buf.readUInt32LE(idx + 18);
      const compression = buf.readUInt16LE(idx + 8);
      if (fn === name) return { fn, dataStart, compressedSize, compression };
      pos = idx + 1;
    }
    return null;
  }

  const entry = findZipEntry(buf, 'MANIFEST.json');
  if (!entry) return { ok: false, error: 'MANIFEST.json not found in bundle.' };

  // If stored (compression=0), read directly
  if (entry.compression === 0) {
    const raw = buf.slice(entry.dataStart, entry.dataStart + entry.compressedSize).toString('utf8');
    try {
      return { ok: true, ...JSON.parse(raw) };
    } catch { return { ok: false, error: 'Failed to parse MANIFEST.json' }; }
  }

  // Deflate compressed — use zlib
  const zlib = require('zlib');
  const compressed = buf.slice(entry.dataStart, entry.dataStart + entry.compressedSize);
  try {
    const raw = zlib.inflateRawSync(compressed).toString('utf8');
    return { ok: true, ...JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: 'Decompression failed: ' + e.message };
  }
}

function toolReadBundleCsv(args) {
  const model = args.model;
  const offset = Number(args.offset || 0);
  const limit = Math.min(Number(args.limit || 5000), 10000);
  if (!model) return { ok: false, error: 'model is required' };

  const latest = path.join(CSV_BUNDLE_ROOT, 'latest_audit_bundle.zip');
  if (!fs.existsSync(latest)) {
    return { ok: false, error: 'No bundle found. Run generate_audit_csv_bundle.py first.' };
  }

  const buf = fs.readFileSync(latest);
  const zlib = require('zlib');
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const targetName = `${model}.csv`;
  let pos = 0;
  let csvText = null;

  while (pos < buf.length - 30) {
    const idx = buf.indexOf(sig, pos);
    if (idx === -1) break;
    const fnLen = buf.readUInt16LE(idx + 26);
    const extraLen = buf.readUInt16LE(idx + 28);
    const fn = buf.slice(idx + 30, idx + 30 + fnLen).toString('utf8');
    const dataStart = idx + 30 + fnLen + extraLen;
    const compressedSize = buf.readUInt32LE(idx + 18);
    const compression = buf.readUInt16LE(idx + 8);

    if (fn === targetName) {
      try {
        const compressed = buf.slice(dataStart, dataStart + compressedSize);
        csvText = (compression === 0 ? compressed : zlib.inflateRawSync(compressed)).toString('utf8');
      } catch (e) { return { ok: false, error: 'Decompression error: ' + e.message }; }
      break;
    }
    pos = idx + 1;
  }

  if (!csvText) return { ok: false, error: `${targetName} not found in bundle. Available models: account.move, account.move.line, account.payment, pos.order, pos.order.line, pos.payment, etc.` };

  const lines = csvText.split('\n').filter(l => l.trim());
  const header = lines[0];
  const dataLines = lines.slice(1);
  const page = dataLines.slice(offset, offset + limit);
  const totalRows = dataLines.length;

  return {
    ok: true,
    model,
    total_rows: totalRows,
    offset,
    limit,
    returned: page.length,
    has_more: offset + limit < totalRows,
    next_offset: offset + limit < totalRows ? offset + limit : null,
    header_row: header,
    csv_text: [header, ...page].join('\n'),
    audit_note: `Complete field-selected CSV data for ${model}. No pre-filtering applied — all rows included.`,
  };
}

function toolHelp() {
  return {
    ok: true,
    server: 'Odoo EOFY Forensic MCP v3 — Ride Electric Brisbane',
    scope: SCOPE,
    export_root: EXPORT_ROOT,
    audit_methodology: [
      'This server provides DATA. Anomaly detection is YOUR job as auditor.',
      'Pre-computed metrics (totals, balances, monthly summaries) are ORIENTATION — use them to understand scale.',
      'Pre-computed anomaly packs are LEADS generated by extraction scripts — treat as starting points, not conclusions.',
      'For each area you audit, use odoo_model_evidence or odoo_stratified_sample to get actual records.',
      'Use odoo_control_totals_with_sample to verify your analysis against full-population control totals.',
      'Use odoo_journal_entry_detail to inspect any specific journal entry end-to-end.',
      'Use odoo_model_rows with offset/limit to page through complete datasets for targeted models.',
      'State limitations explicitly when models are missing or samples are used instead of complete data.',
    ],
    token_strategy: [
      'RECOMMENDED AUDIT START: call odoo_audit_init — one call gives you everything to orient the session.',
      '1. odoo_audit_init → scope, all models, field index, pre-computed orientation, anomaly leads (FIRST call)',
      '2. odoo_schema(model) → inspect field types and completeness before querying',
      '3. odoo_aggregate(model, group_by, metrics) → GROUP BY any field with zero raw row cost (pattern detection)',
      '4. odoo_query(model, filters, fields, limit) → pull exactly the rows you need with server-side filtering',
      '5. odoo_journal_entry_detail → drill into specific journal entries end-to-end',
      '6. odoo_bundle_csv → full unfiltered CSV access (up to 10k rows per call) when you want all data',
      'FILTER OPERATORS: eq, ne, gt, gte, lt, lte, in, not_in, contains, not_contains, startswith, isnull, notnull, gt_date, gte_date, lt_date, lte_date',
      'AGGREGATION: count, sum:field, min:field, max:field, avg:field — server-side, no raw row transmission',
      'Use fields[] to project only required columns; use offset/limit to paginate large results.',
    ],
    tools: TOOLS_MANIFEST.map(t => ({ name: t.name, description: t.description })),
  };
}

// ─── TOOL MANIFEST ────────────────────────────────────────────────────────────

const TOOLS_MANIFEST = [
  {
    name: 'odoo_snapshot_list',
    description: 'List all available forensic export snapshots and which stages have been completed (ledger, POS, sanitised, audit report).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'odoo_catalogue',
    description: 'Master catalogue: available models, row counts, extraction gaps, pre-computed pack availability, and readiness summary for a snapshot. Call this first.',
    inputSchema: {
      type: 'object',
      properties: { snapshot_id: { type: 'string', description: 'Snapshot ID. Omit to use latest.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_extraction_status',
    description: 'Extraction completeness status per stage: which models succeeded, which failed with API errors, and what is blocked.',
    inputSchema: {
      type: 'object',
      properties: { snapshot_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_precomputed_metrics',
    description: 'Return pre-computed metric packs produced by the exporter: ledger totals, monthly debit/credit, trial balance by account, reconciliation counts, POS totals. TOKEN-EFFICIENT — no raw rows.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string' },
        stage: { type: 'string', enum: ['all', '01_account_ledger', '02_pos_retail', '05_master_data'], description: 'Omit or "all" to return all stages.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_precomputed_anomalies',
    description: 'Return pre-computed anomaly packs: line_modified_after_period_end, non_posted_move_line, pos_order_missing_account_move, etc. TOKEN-EFFICIENT — use this before querying raw rows.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string' },
        stage: { type: 'string', enum: ['all', '01_account_ledger', '02_pos_retail', '05_master_data'] },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'Filter by severity. Omit for all.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max anomalies returned. Default 200.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_ledger_integrity',
    description: 'Ledger integrity checks: debit/credit balance per journal entry, monthly totals, unbalanced moves, reconciliation gap. Uses pre-computed pack when available.',
    inputSchema: {
      type: 'object',
      properties: { snapshot_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_pos_integrity',
    description: 'POS integrity checks: order vs payment amount mismatches, orders without linked account.move, monthly POS totals. Uses pre-computed pack when available.',
    inputSchema: {
      type: 'object',
      properties: { snapshot_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_late_writes',
    description: 'Find records modified after FY end (write_date >= 2025-07-01). Applies to account.move.line by default. Returns only anomalous records.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string' },
        model: { type: 'string', description: 'Default: account.move.line. Can also use account.move.' },
        threshold: { type: 'string', description: 'ISO date. Default: 2025-07-01.' },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_unreconciled',
    description: 'Unreconciled receivable and payable lines from account.move.line. Returns balance totals by account and top unreconciled records.',
    inputSchema: {
      type: 'object',
      properties: { snapshot_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_monthly_summary',
    description: 'Pre-aggregated monthly debit/credit/balance for ledger and POS. TOKEN-EFFICIENT — returns aggregates only, no row data.',
    inputSchema: {
      type: 'object',
      properties: { snapshot_id: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_model_rows',
    description: 'Paginate rows for any model. Use offset/limit for pagination. Use fields[] to return only required columns. MAX 2000 rows per call.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string' },
        model: { type: 'string', description: 'Dotted model name e.g. account.move.line or account_move_line.' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 2000 },
        fields: { type: 'array', items: { type: 'string' }, description: 'Return only these fields. Omit for all fields.' },
      },
      required: ['model'],
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_record_by_id',
    description: 'Retrieve a specific record by model and Odoo id.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string' },
        model: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['model', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_search',
    description: 'Full-text search across one model or all models. Returns matching rows up to limit.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string' },
        model: { type: 'string', description: 'Omit to search all models.' },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_stratified_sample',
    description: 'Return N rows evenly distributed across the full date range of a model (early, mid, late FY). Use this to get representative data for independent anomaly detection. NOT pre-filtered — raw data, your conclusions.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string' },
        model: { type: 'string', description: 'e.g. account.move.line, pos.order, account.payment' },
        n: { type: 'integer', minimum: 1, maximum: 500, description: 'Number of rows to return evenly distributed across FY. Default 50.' },
        date_field: { type: 'string', description: 'Field to sort/distribute by. Auto-detected if omitted.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Return only these fields. Omit for all.' },
      },
      required: ['model'],
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_control_totals_with_sample',
    description: 'Return control totals computed from ALL rows of a model (debit, credit, balance, by-month, by-account, by-journal) PLUS a stratified sample of raw rows. Use to anchor your independent analysis against full-population figures.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string' },
        model: { type: 'string', description: 'Default: account.move.line' },
        sample_n: { type: 'integer', minimum: 1, maximum: 200, description: 'Rows in the stratified sample. Default 50.' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Limit fields in the sample rows.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_model_evidence',
    description: 'Return complete dataset for small models, or a stratified sample + control totals for large ones. Use as the primary entry point for auditing any model. Returns is_complete_dataset=true when all rows fit in the response.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string' },
        model: { type: 'string' },
        max_rows: { type: 'integer', minimum: 1, maximum: 500, description: 'Max rows returned. Default 200.' },
        fields: { type: 'array', items: { type: 'string' } },
      },
      required: ['model'],
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_journal_entry_detail',
    description: 'Return the full journal entry header (account.move) and all debit/credit lines (account.move.line) for one or more move_ids. Includes a balance check per entry. Use for end-to-end inspection of a specific transaction.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string' },
        move_ids: { type: 'array', items: { type: 'string' }, description: 'Odoo move IDs (numeric) to retrieve.' },
        move_name: { type: 'string', description: 'Partial move name/reference to search for (e.g. INV/2025/00042).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_audit_init',
    description: 'CALL THIS FIRST. Returns a comprehensive bootstrap package for starting an independent forensic audit: scope, all available models with row counts, field index for key models, pre-computed orientation totals, anomaly leads, and a tool guide. One call to orient the entire audit session.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string', description: 'Snapshot ID. Omit for latest.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_query',
    description: 'Flexible, unrestricted query on any model. Filter by any field using eq/ne/gt/gte/lt/lte/in/not_in/contains/not_contains/startswith/isnull/notnull/gt_date/gte_date/lt_date/lte_date operators. Sort, paginate, and project fields. This is the primary raw data access tool — no pre-filtering, your analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string', description: 'Omit for latest.' },
        model: { type: 'string', description: 'Odoo model, e.g. account.move.line, pos.order, account.payment.' },
        filters: {
          type: 'array',
          description: 'Filter conditions applied server-side before returning rows.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              op: { type: 'string', enum: ['eq','ne','gt','gte','lt','lte','in','not_in','contains','not_contains','startswith','isnull','notnull','gt_date','gte_date','lt_date','lte_date'] },
              value: { description: 'Value to compare against. For in/not_in, use an array.' },
            },
            required: ['field', 'op'],
          },
        },
        fields: { type: 'array', items: { type: 'string' }, description: 'Return only these fields. Omit for all.' },
        limit: { type: 'integer', minimum: 1, maximum: 10000, description: 'Max rows. Default 1000.' },
        offset: { type: 'integer', minimum: 0, description: 'Row offset for pagination. Default 0.' },
        sort_by: { type: 'string', description: 'Field to sort by.' },
        sort_dir: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction. Default asc.' },
      },
      required: ['model'],
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_aggregate',
    description: 'Server-side GROUP BY aggregation on any model with any filter. Metrics: count, sum:field, min:field, max:field, avg:field. Token cost is constant — returns grouped totals only, no raw rows. Essential for pattern detection across large datasets.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string', description: 'Omit for latest.' },
        model: { type: 'string', description: 'Odoo model to aggregate.' },
        group_by: { type: 'array', items: { type: 'string' }, description: 'Field names to group by. Empty array returns single aggregate across all rows.' },
        metrics: { type: 'array', items: { type: 'string' }, description: 'e.g. ["count","sum:debit","sum:credit","min:date","max:write_date","avg:balance"]. Default: ["count"].' },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              op: { type: 'string', enum: ['eq','ne','gt','gte','lt','lte','in','not_in','contains','not_contains','startswith','isnull','notnull','gt_date','gte_date','lt_date','lte_date'] },
              value: {},
            },
            required: ['field', 'op'],
          },
          description: 'Pre-group filters. Applied before aggregation.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'Max groups to return. Default 1000.' },
        sort_by: { type: 'string', description: 'Sort by this metric key, e.g. "count", "sum_debit". Default: count.' },
        sort_dir: { type: 'string', enum: ['asc', 'desc'], description: 'Default desc.' },
      },
      required: ['model'],
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_schema',
    description: 'Inspect the field schema for any model: field names, types, completeness percentage, null rates, sample values, and numeric min/max/sum. Call this before querying a model to understand the data shape. Omit model to list all available models.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot_id: { type: 'string', description: 'Omit for latest.' },
        model: { type: 'string', description: 'Odoo model. Omit to get list of all models.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_bundle_list',
    description: 'List available compact audit CSV bundles. Each bundle is a ZIP (~1.3MB) containing one CSV per Odoo model with audit-critical fields — no join tables, no pre-filtering. Download and upload directly to Claude for full data access.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'odoo_bundle_manifest',
    description: 'Read MANIFEST.json from the latest audit bundle: model list, row counts, control totals (sum/min/max per numeric field computed over ALL rows). Use to verify your analysis without reading raw rows.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'odoo_bundle_csv',
    description: 'Read CSV data for any model from the latest audit bundle. Returns raw, unfiltered, field-selected CSV text. Paginate with offset/limit. Up to 10,000 rows per call. This is the purest data access path for Claude.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'e.g. account.move, account.move.line, pos.order, account.payment' },
        offset: { type: 'integer', minimum: 0, description: 'Row offset (excluding header). Default 0.' },
        limit: { type: 'integer', minimum: 1, maximum: 10000, description: 'Rows to return. Default 5000.' },
      },
      required: ['model'],
      additionalProperties: false,
    },
  },
  {
    name: 'odoo_help',
    description: 'Audit methodology guide, token strategy, and all tool descriptions. Read this first to understand how to use the server correctly for independent forensic analysis.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ─── TOOL DISPATCH ────────────────────────────────────────────────────────────

function callTool(name, args) {
  switch (name) {
    case 'odoo_snapshot_list':             return toolSnapshotList();
    case 'odoo_catalogue':                 return toolCatalogue(args);
    case 'odoo_extraction_status':         return toolExtractionStatus(args);
    case 'odoo_precomputed_metrics':       return toolPrecomputedMetrics(args);
    case 'odoo_precomputed_anomalies':     return toolPrecomputedAnomalies(args);
    case 'odoo_ledger_integrity':          return toolLedgerIntegrity(args);
    case 'odoo_pos_integrity':             return toolPOSIntegrity(args);
    case 'odoo_late_writes':               return toolLateWrites(args);
    case 'odoo_unreconciled':              return toolUnreconciledBalance(args);
    case 'odoo_monthly_summary':           return toolAggregateMonthly(args);
    case 'odoo_model_rows':                return toolModelRows(args);
    case 'odoo_record_by_id':             return toolRecordById(args);
    case 'odoo_search':                    return toolSearchRows(args);
    case 'odoo_audit_init':                return toolAuditInit(args);
    case 'odoo_query':                     return toolQuery(args);
    case 'odoo_aggregate':                 return toolAggregate(args);
    case 'odoo_schema':                    return toolSchema(args);
    case 'odoo_stratified_sample':         return toolStratifiedSample(args);
    case 'odoo_control_totals_with_sample': return toolControlTotalsWithSample(args);
    case 'odoo_model_evidence':            return toolModelEvidence(args);
    case 'odoo_journal_entry_detail':      return toolJournalEntryDetail(args);
    case 'odoo_bundle_list':               return toolListBundles();
    case 'odoo_bundle_manifest':           return toolReadBundleManifest(args);
    case 'odoo_bundle_csv':                return toolReadBundleCsv(args);
    case 'odoo_help':                      return toolHelp();
    default: throw new Error('Unknown tool: ' + name);
  }
}

// ─── MCP REQUEST HANDLER ──────────────────────────────────────────────────────

const input = $input.first().json;

if (!authOk(input)) {
  return [{ json: rpcErr(null, -32001, 'Unauthorized. Supply Authorization: Bearer <token>.', { ok: false }) }];
}

const body = input.body || {};
const method = body.method;
const id = body.id ?? null;

try {
  if (method === 'initialize') {
    return [{ json: rpcOk(id, {
      protocolVersion: body.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'odoo-eofy-forensic-mcp', version: '3.1.0' },
    }) }];
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    return [{ json: rpcOk(id, {}) }];
  }

  if (method === 'tools/list') {
    return [{ json: rpcOk(id, { tools: TOOLS_MANIFEST }) }];
  }

  if (method === 'tools/call') {
    const toolName = body.params?.name;
    const args = body.params?.arguments || {};
    const result = callTool(toolName, args);
    return [{ json: rpcOk(id, ok(result)) }];
  }

  return [{ json: rpcErr(id, -32601, 'Method not found: ' + method, { ok: false }) }];
} catch (e) {
  return [{ json: rpcErr(id, -32000, String(e.message || e), { stack: String(e.stack || '') }) }];
}
