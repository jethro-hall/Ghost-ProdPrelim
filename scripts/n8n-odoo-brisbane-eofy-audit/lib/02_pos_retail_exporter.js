#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const inputPath = process.env.ODOO_02_INPUT || '/tmp/odoo_02_pos_retail_input.json';
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function req(o, k) {
  if (o[k] === undefined || o[k] === null || String(o[k]).trim() === '') {
    throw new Error(`Missing input ${k}`);
  }
  return o[k];
}
function ids(v) {
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  return String(v).split(',').map((x) => Number(String(x).trim())).filter(Number.isFinite);
}
function mkdir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function safe(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, '_');
}
function write(file, obj) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8');
}
function appendJsonl(file, rows) {
  mkdir(path.dirname(file));
  if (rows.length) fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function relId(v) {
  return Array.isArray(v) ? v[0] : v;
}
function relLabel(v) {
  return Array.isArray(v) ? v[1] : undefined;
}
function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}
function month(s) {
  return String(s || '').slice(0, 7) || 'unknown';
}

const targetCompanyRaw = input.target_company_id ?? input.company_id;
if (targetCompanyRaw === undefined || targetCompanyRaw === null || String(targetCompanyRaw).trim() === '') {
  throw new Error('Missing input target_company_id (or company_id)');
}

const cfg = {
  snapshot_id: req(input, 'snapshot_id'),
  target_company_id: n(targetCompanyRaw),
  target_company_name: input.target_company_name || 'Ride Electric Brisbane',
  company_context_ids: ids(req(input, 'company_context_ids')),
  date_start: req(input, 'date_start'),
  date_end: req(input, 'date_end'),
  timezone: input.timezone || 'Australia/Brisbane',
  odoo_base_url: String(req(input, 'odoo_base_url')).replace(/\/$/, ''),
  odoo_db: req(input, 'odoo_db'),
  odoo_username: req(input, 'odoo_username'),
  odoo_api_key_or_password: String(req(input, 'odoo_api_key_or_password')).trim(),
  page_limit: Math.max(25, n(input.page_limit, 500)),
  output_root: String(input.output_root || '/home/node/.n8n/odoo_forensic_exports').replace(/\/$/, ''),
  max_anomaly_evidence_rows: Math.max(25, n(input.max_anomaly_evidence_rows, 500)),
};
if (!cfg.company_context_ids.includes(cfg.target_company_id)) {
  cfg.company_context_ids.unshift(cfg.target_company_id);
}

const started = new Date().toISOString();
const stage = '02_pos_retail';
const base = `${cfg.output_root}/${cfg.snapshot_id}/${stage}`;
for (const d of ['raw', 'metrics', 'anomalies', 'html', 'manifests']) mkdir(path.join(base, d));

const outputFiles = [];
const apiErrors = [];
const warnings = [];
const counts = {};
const statuses = {};
const fieldsCoverage = {};
const anomalies = [];
const anomalyCounts = {};
const blocked = [];

const orderTotals = new Map();
const orderPaid = new Map();
const lineTotals = new Map();
const paymentTotals = new Map();

const metrics = {
  stage,
  pos: {
    order_count: 0,
    line_count: 0,
    payment_count: 0,
    amount_total: 0,
    amount_tax: 0,
    amount_paid: 0,
    amount_return: 0,
    by_month: {},
    by_state: {},
    by_payment_method: {},
    orders_with_account_move: 0,
    orders_missing_account_move: 0,
  },
  integrity: {
    order_total_mismatch_count: 0,
    amount_paid_mismatch_count: 0,
    order_total_mismatch_examples: [],
    amount_paid_mismatch_examples: [],
  },
};

function addAnomaly(severity, type, message, evidence) {
  anomalyCounts[type] = (anomalyCounts[type] || 0) + 1;
  if (anomalies.length < cfg.max_anomaly_evidence_rows) {
    anomalies.push({ severity, type, message, evidence });
  }
}

async function rpc(service, method, args) {
  const body = {
    jsonrpc: '2.0',
    method: 'call',
    params: { service, method, args },
    id: `${service}_${method}_${Date.now()}`,
  };
  const res = await fetch(`${cfg.odoo_base_url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new Error(`Non JSON Odoo response HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  if (j.error) {
    const err = new Error(j.error?.data?.message || j.error?.message || 'Odoo JSON-RPC error');
    err.odoo = j.error;
    throw err;
  }
  return j.result;
}

async function authenticate() {
  const uid = await rpc('common', 'authenticate', [
    cfg.odoo_db,
    cfg.odoo_username,
    cfg.odoo_api_key_or_password,
    {},
  ]);
  if (!uid || typeof uid !== 'number') {
    throw new Error(`Odoo authentication failed. uid=${JSON.stringify(uid)}`);
  }
  return uid;
}

async function kw(uid, model, method, args = [], kwargs = {}) {
  return await rpc('object', 'execute_kw', [
    cfg.odoo_db,
    uid,
    cfg.odoo_api_key_or_password,
    model,
    method,
    args,
    kwargs,
  ]);
}

const ctx = {
  allowed_company_ids: cfg.company_context_ids,
  company_id: cfg.target_company_id,
  active_test: false,
  lang: 'en_AU',
  tz: cfg.timezone,
};

const models = [
  {
    model: 'pos.config',
    date: null,
    company: 'company_id',
    shared: true,
    fields: ['id', 'name', 'company_id', 'active', 'create_date', 'write_date'],
  },
  {
    model: 'pos.payment.method',
    date: null,
    company: 'company_id',
    shared: true,
    fields: ['id', 'name', 'is_cash_count', 'company_id', 'create_date', 'write_date'],
  },
  {
    model: 'pos.category',
    date: null,
    company: null,
    fields: ['id', 'name', 'parent_id', 'create_date', 'write_date'],
  },
  {
    model: 'pos.session',
    date: 'start_at',
    company: 'company_id',
    fields: ['id', 'name', 'config_id', 'state', 'start_at', 'stop_at', 'company_id', 'create_date', 'write_date'],
  },
  {
    model: 'pos.order',
    date: 'date_order',
    company: 'company_id',
    fields: [
      'id', 'name', 'date_order', 'session_id', 'config_id', 'partner_id', 'user_id',
      'company_id', 'amount_total', 'amount_tax', 'amount_paid', 'amount_return', 'state',
      'account_move', 'create_uid', 'create_date', 'write_uid', 'write_date',
    ],
  },
  {
    model: 'pos.order.line',
    date: 'create_date',
    company: 'company_id',
    fields: [
      'id', 'order_id', 'product_id', 'qty', 'price_unit', 'discount', 'price_subtotal',
      'price_subtotal_incl', 'tax_ids', 'create_date', 'write_date',
    ],
  },
  {
    model: 'pos.payment',
    date: 'payment_date',
    company: 'company_id',
    fields: [
      'id', 'pos_order_id', 'payment_method_id', 'amount', 'payment_date', 'session_id',
      'company_id', 'create_uid', 'create_date', 'write_uid', 'write_date',
    ],
  },
];

function domainFor(modelConfig, available) {
  const d = [];
  if (modelConfig.date && available.has(modelConfig.date)) {
    d.push([modelConfig.date, '>=', cfg.date_start]);
    d.push([modelConfig.date, '<=', cfg.date_end]);
  }
  if (modelConfig.company && available.has(modelConfig.company)) {
    if (modelConfig.shared) {
      d.push('|');
      d.push([modelConfig.company, '=', false]);
      d.push([modelConfig.company, 'in', cfg.company_context_ids]);
    } else {
      d.push([modelConfig.company, '=', cfg.target_company_id]);
    }
  }
  return d;
}

function flatten(row) {
  const out = { ...row };
  for (const [k, v] of Object.entries(row)) {
    if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number') {
      out[`${k}_id`] = v[0];
      out[`${k}_label`] = v[1];
    }
  }
  return out;
}

function trackOrder(row) {
  const orderId = row.id;
  orderTotals.set(orderId, {
    order_id: orderId,
    name: row.name,
    amount_total: round2(row.amount_total),
    amount_paid: round2(row.amount_paid),
    state: row.state,
    account_move_id: relId(row.account_move),
    date_order: row.date_order,
  });
  orderPaid.set(orderId, round2(row.amount_paid));

  metrics.pos.order_count++;
  metrics.pos.amount_total += Number(row.amount_total) || 0;
  metrics.pos.amount_tax += Number(row.amount_tax) || 0;
  metrics.pos.amount_paid += Number(row.amount_paid) || 0;
  metrics.pos.amount_return += Number(row.amount_return) || 0;

  const m = month(row.date_order);
  if (!metrics.pos.by_month[m]) {
    metrics.pos.by_month[m] = { orders: 0, amount_total: 0, amount_tax: 0, amount_paid: 0 };
  }
  metrics.pos.by_month[m].orders++;
  metrics.pos.by_month[m].amount_total += Number(row.amount_total) || 0;
  metrics.pos.by_month[m].amount_tax += Number(row.amount_tax) || 0;
  metrics.pos.by_month[m].amount_paid += Number(row.amount_paid) || 0;

  const st = row.state || 'unknown';
  metrics.pos.by_state[st] = (metrics.pos.by_state[st] || 0) + 1;

  if (relId(row.account_move)) metrics.pos.orders_with_account_move++;
  else if (row.state === 'paid' || row.state === 'done' || row.state === 'invoiced') {
    metrics.pos.orders_missing_account_move++;
    addAnomaly('high', 'pos_order_missing_account_move', 'Paid/done POS order missing account_move.', {
      order_id: orderId,
      name: row.name,
      state: row.state,
      amount_total: row.amount_total,
    });
  }

  if (Number(row.amount_return) > 0) {
    addAnomaly('medium', 'pos_order_with_return', 'POS order has return amount.', {
      order_id: orderId,
      amount_return: row.amount_return,
      amount_total: row.amount_total,
    });
  }
}

function trackLine(row) {
  metrics.pos.line_count++;
  const orderId = relId(row.order_id);
  if (!lineTotals.has(orderId)) lineTotals.set(orderId, 0);
  lineTotals.set(orderId, lineTotals.get(orderId) + (Number(row.price_subtotal_incl) || Number(row.price_subtotal) || 0));
}

function trackPayment(row) {
  metrics.pos.payment_count++;
  const orderId = relId(row.pos_order_id);
  const amt = Number(row.amount) || 0;
  if (!paymentTotals.has(orderId)) paymentTotals.set(orderId, 0);
  paymentTotals.set(orderId, paymentTotals.get(orderId) + amt);

  const method = relLabel(row.payment_method_id) || String(relId(row.payment_method_id) || 'unknown');
  if (!metrics.pos.by_payment_method[method]) {
    metrics.pos.by_payment_method[method] = { count: 0, amount: 0 };
  }
  metrics.pos.by_payment_method[method].count++;
  metrics.pos.by_payment_method[method].amount += amt;
}

async function exportModel(uid, mc) {
  statuses[mc.model] = 'started';
  try {
    const fg = await kw(uid, mc.model, 'fields_get', [], { attributes: ['string', 'type', 'relation', 'store'] });
    const available = new Set(Object.keys(fg || {}));
    const selected = ['id', ...mc.fields.filter((f) => f !== 'id' && available.has(f))];
    const missing = mc.fields.filter((f) => f !== 'id' && !available.has(f));
    const domain = domainFor(mc, available);

    fieldsCoverage[mc.model] = {
      selected_fields: selected,
      missing_requested_fields: missing,
      date_field: mc.date,
      company_field: mc.company,
      domain,
    };
    if (missing.length) warnings.push(`${mc.model}: missing requested fields: ${missing.join(', ')}`);
    write(path.join(base, 'manifests', `${safe(mc.model)}_field_coverage.json`), fieldsCoverage[mc.model]);

    let count = 0;
    try {
      count = await kw(uid, mc.model, 'search_count', [domain], { context: ctx });
    } catch (e) {
      apiErrors.push({ model: mc.model, method: 'search_count', error: e.message, domain });
      statuses[mc.model] = 'failed_count';
      return;
    }
    counts[mc.model] = count;

    const rawFile = path.join(base, 'raw', `${safe(mc.model)}.jsonl`);
    if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);

    for (let offset = 0; offset < count; offset += cfg.page_limit) {
      let rows;
      try {
        rows = await kw(uid, mc.model, 'search_read', [domain], {
          fields: selected.filter((f) => f !== 'id'),
          offset,
          limit: cfg.page_limit,
          order: 'id asc',
          context: ctx,
        });
      } catch (e) {
        apiErrors.push({
          model: mc.model,
          method: 'search_read',
          offset,
          limit: cfg.page_limit,
          error: e.message,
          domain,
        });
        statuses[mc.model] = 'partial_search_read_failure';
        break;
      }

      const enriched = rows.map((r) => ({
        ...flatten(r),
        _export: {
          snapshot_id: cfg.snapshot_id,
          subworkflow: stage,
          model: mc.model,
          model_slug: safe(mc.model),
          offset,
          limit: cfg.page_limit,
          exported_at: new Date().toISOString(),
          source_company_context: cfg.company_context_ids,
          target_company_id: cfg.target_company_id,
        },
      }));
      appendJsonl(rawFile, enriched);
      if (!outputFiles.includes(rawFile)) outputFiles.push(rawFile);

      for (const row of enriched) {
        if (mc.model === 'pos.order') trackOrder(row);
        if (mc.model === 'pos.order.line') trackLine(row);
        if (mc.model === 'pos.payment') trackPayment(row);
      }
    }

    if (!String(statuses[mc.model]).includes('partial')) statuses[mc.model] = 'success';
  } catch (e) {
    apiErrors.push({ model: mc.model, method: 'exportModel', error: e.message });
    statuses[mc.model] = 'failed';
  }
}

function roundObject(o) {
  for (const k of Object.keys(o)) {
    if (typeof o[k] === 'number') o[k] = round2(o[k]);
    else if (o[k] && typeof o[k] === 'object') roundObject(o[k]);
  }
}

function runIntegrityChecks() {
  for (const [orderId, order] of orderTotals.entries()) {
    const lineSum = round2(lineTotals.get(orderId) || 0);
    const paySum = round2(paymentTotals.get(orderId) || 0);
    const totalDelta = round2(order.amount_total - lineSum);
    const paidDelta = round2(order.amount_paid - paySum);

    if (lineTotals.has(orderId) && Math.abs(totalDelta) > 0.05) {
      metrics.integrity.order_total_mismatch_count++;
      if (metrics.integrity.order_total_mismatch_examples.length < 50) {
        metrics.integrity.order_total_mismatch_examples.push({
          order_id: orderId,
          amount_total: order.amount_total,
          line_sum: lineSum,
          delta: totalDelta,
        });
      }
      addAnomaly('high', 'pos_order_total_vs_lines', 'POS order total does not match sum of lines.', {
        order_id: orderId,
        amount_total: order.amount_total,
        line_sum: lineSum,
        delta: totalDelta,
      });
    }

    if (paymentTotals.has(orderId) && Math.abs(paidDelta) > 0.05) {
      metrics.integrity.amount_paid_mismatch_count++;
      if (metrics.integrity.amount_paid_mismatch_examples.length < 50) {
        metrics.integrity.amount_paid_mismatch_examples.push({
          order_id: orderId,
          amount_paid: order.amount_paid,
          payment_sum: paySum,
          delta: paidDelta,
        });
      }
      addAnomaly('high', 'pos_amount_paid_vs_payments', 'POS amount_paid does not match sum of payments.', {
        order_id: orderId,
        amount_paid: order.amount_paid,
        payment_sum: paySum,
        delta: paidDelta,
      });
    }
  }
}

function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function htmlTable(rows, cols) {
  if (!rows.length) return '<p>No rows.</p>';
  return `<table><thead><tr>${cols.map((c) => `<th>${htmlEscape(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${htmlEscape(c.value(r))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function buildHtml() {
  const monthRows = Object.entries(metrics.pos.by_month)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, v]) => ({ month: m, ...v }));
  const methodRows = Object.entries(metrics.pos.by_payment_method)
    .map(([method, v]) => ({ method, ...v }))
    .sort((a, b) => b.amount - a.amount);
  return `<!doctype html><html><head><meta charset="utf-8"><title>02 POS Retail</title><style>
body{font-family:Arial;margin:28px;background:#f8f9fb;color:#1f2937}.card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border:1px solid #e5e7eb;padding:6px;text-align:left}th{background:#f3f4f6}
</style></head><body>
<h1>02 POS Retail Deep Dive</h1>
<div class="card"><b>Snapshot:</b> ${htmlEscape(cfg.snapshot_id)}<br><b>Company:</b> ${htmlEscape(cfg.target_company_name)} (${cfg.target_company_id})<br><b>Period:</b> ${cfg.date_start} to ${cfg.date_end}</div>
<div class="card"><h2>Totals</h2><table>
<tr><th>Orders</th><td>${metrics.pos.order_count}</td></tr>
<tr><th>Lines</th><td>${metrics.pos.line_count}</td></tr>
<tr><th>Payments</th><td>${metrics.pos.payment_count}</td></tr>
<tr><th>Amount total</th><td>${metrics.pos.amount_total}</td></tr>
<tr><th>Amount tax</th><td>${metrics.pos.amount_tax}</td></tr>
<tr><th>Amount paid</th><td>${metrics.pos.amount_paid}</td></tr>
<tr><th>Order total mismatches</th><td>${metrics.integrity.order_total_mismatch_count}</td></tr>
<tr><th>Amount paid mismatches</th><td>${metrics.integrity.amount_paid_mismatch_count}</td></tr>
</table></div>
<div class="card"><h2>Model Counts</h2>${htmlTable(Object.entries(counts).map(([model, count]) => ({ model, count, status: statuses[model] })), [{ label: 'Model', value: (r) => r.model }, { label: 'Records', value: (r) => r.count }, { label: 'Status', value: (r) => r.status }])}</div>
<div class="card"><h2>Sales by Month</h2>${htmlTable(monthRows, [{ label: 'Month', value: (r) => r.month }, { label: 'Orders', value: (r) => r.orders }, { label: 'Total', value: (r) => r.amount_total }, { label: 'Tax', value: (r) => r.amount_tax }, { label: 'Paid', value: (r) => r.amount_paid }])}</div>
<div class="card"><h2>Payment Methods</h2>${htmlTable(methodRows, [{ label: 'Method', value: (r) => r.method }, { label: 'Count', value: (r) => r.count }, { label: 'Amount', value: (r) => r.amount }])}</div>
<div class="card"><h2>Anomaly Counts</h2>${htmlTable(Object.entries(anomalyCounts).map(([type, count]) => ({ type, count })), [{ label: 'Type', value: (r) => r.type }, { label: 'Count', value: (r) => r.count }])}</div>
<div class="card"><h2>API Errors</h2><pre>${htmlEscape(JSON.stringify(apiErrors, null, 2))}</pre></div>
</body></html>`;
}

async function main() {
  const uid = await authenticate();

  for (const mc of models) await exportModel(uid, mc);

  runIntegrityChecks();

  roundObject(metrics);

  const requiredModels = ['pos.order', 'pos.order.line', 'pos.payment'];
  for (const m of requiredModels) {
    if (!counts[m] && statuses[m] !== 'success') {
      blocked.push(`POS conclusions blocked: ${m} missing or failed. Check Odoo POS/Inventory permissions.`);
    }
  }

  const stagePack = {
    snapshot_id: cfg.snapshot_id,
    stage,
    company: { id: cfg.target_company_id, name: cfg.target_company_name, context_ids: cfg.company_context_ids },
    period: { start: cfg.date_start, end: cfg.date_end, timezone: cfg.timezone },
    started_at: started,
    completed_at: new Date().toISOString(),
    model_statuses: statuses,
    record_counts: counts,
    field_coverage: fieldsCoverage,
    metrics,
    anomaly_counts: anomalyCounts,
    high_risk_anomalies: anomalies.filter((a) => ['critical', 'high'].includes(a.severity)).slice(0, 50),
    blocked_metrics: blocked,
    warnings,
    api_errors: apiErrors,
    output_files: outputFiles,
  };

  const metricFile = path.join(base, 'metrics/pos_retail_metric_pack.json');
  const anomalyFile = path.join(base, 'anomalies/pos_retail_anomaly_pack.json');
  const packFile = path.join(base, 'manifests/pos_retail_stage_pack.json');
  const htmlFile = path.join(base, 'html/pos_retail_deep_dive.html');
  const resultFile = path.join(base, 'manifests/subworkflow_result.json');

  write(metricFile, metrics);
  write(anomalyFile, { anomaly_counts: anomalyCounts, anomalies, blocked_metrics: blocked });
  write(packFile, stagePack);
  write(path.join(base, 'manifests/model_counts.json'), counts);
  write(path.join(base, 'manifests/api_errors.json'), apiErrors);
  write(path.join(base, 'manifests/warnings.json'), warnings);
  write(htmlFile, buildHtml());

  const posReady = requiredModels.every((m) => statuses[m] === 'success' && (counts[m] || 0) > 0);

  const result = {
    subworkflow: '02_SUB_POS_RETAIL',
    status: apiErrors.length ? 'partial' : 'success',
    pos_readiness: posReady && !blocked.length ? 'ready' : 'partial',
    snapshot_id: cfg.snapshot_id,
    company_id: cfg.target_company_id,
    period: `${cfg.date_start} to ${cfg.date_end}`,
    started_at: started,
    completed_at: new Date().toISOString(),
    models_attempted: models.map((m) => m.model),
    models_exported: Object.entries(statuses).filter(([, s]) => s === 'success').map(([m]) => m),
    records_exported: counts,
    missing_critical_fields: Object.fromEntries(
      Object.entries(fieldsCoverage)
        .map(([m, c]) => [m, c.missing_requested_fields])
        .filter(([, v]) => v && v.length),
    ),
    api_errors: apiErrors,
    warnings,
    anomaly_counts: anomalyCounts,
    metric_pack_path: metricFile,
    anomaly_pack_path: anomalyFile,
    html_report: htmlFile,
    stage_pack_path: packFile,
    output_base: base,
    output_files: outputFiles,
    summary: {
      order_count: metrics.pos.order_count,
      amount_total: metrics.pos.amount_total,
      amount_tax: metrics.pos.amount_tax,
      amount_paid: metrics.pos.amount_paid,
      order_total_mismatch_count: metrics.integrity.order_total_mismatch_count,
      amount_paid_mismatch_count: metrics.integrity.amount_paid_mismatch_count,
      orders_with_account_move: metrics.pos.orders_with_account_move,
      orders_missing_account_move: metrics.pos.orders_missing_account_move,
      blocked_metrics: blocked,
    },
  };

  write(resultFile, result);
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
