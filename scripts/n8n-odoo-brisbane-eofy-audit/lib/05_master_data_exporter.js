#!/usr/bin/env node
'use strict';

// ─── Stage 05: Master Data, Product, Stock, Tax, and Audit Context Extractor ──
//
// Reads /tmp/odoo_05_master_data_input.json
// Follows the same pattern as 02_pos_retail_exporter.js.
//
// SIZING RECOMMENDATIONS (see README §"Running Stage 05"):
//   page_limit:            200   (safe default for large models like stock.move)
//   cross_ref_sample_limit: 50000 (max rows to read per model for cross-ref ID harvest)
//   For n8n: set workflow execution timeout >= 3600s (Settings → Workflow Settings)
//   For n8n container: NODE_OPTIONS=--max-old-space-size=1536 in docker-compose.yml

const fs   = require('fs');
const path = require('path');

const inputPath = process.env.ODOO_05_INPUT || '/tmp/odoo_05_master_data_input.json';
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function n(v, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function req(o, k) {
  if (o[k] === undefined || o[k] === null || String(o[k]).trim() === '') throw new Error(`Missing input ${k}`);
  return o[k];
}
function ids(v) {
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  return String(v).split(',').map(x => Number(String(x).trim())).filter(Number.isFinite);
}
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function safe(s) { return String(s).replace(/[^a-zA-Z0-9_.-]/g, '_'); }
function write(file, obj) {
  mkdir(path.dirname(file));
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8');
}
function appendJsonl(file, rows) {
  mkdir(path.dirname(file));
  if (rows.length) fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function relId(v) { return Array.isArray(v) ? v[0] : v; }
function relLabel(v) { return Array.isArray(v) ? v[1] : undefined; }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function month(s) { return String(s || '').slice(0, 7) || 'unknown'; }

// ─── Config ───────────────────────────────────────────────────────────────────

const targetCompanyRaw = input.target_company_id ?? input.company_id;
if (!targetCompanyRaw) throw new Error(
  `Missing input target_company_id. Keys received: ${Object.keys(input).join(', ')}`
);

const cfg = {
  snapshot_id:              req(input, 'snapshot_id'),
  target_company_id:        n(targetCompanyRaw),
  target_company_name:      input.target_company_name || 'Ride Electric Brisbane',
  company_context_ids:      ids(req(input, 'company_context_ids')),
  date_start:               req(input, 'date_start'),
  date_end:                 req(input, 'date_end'),
  timezone:                 input.timezone || 'Australia/Brisbane',
  odoo_base_url:            String(req(input, 'odoo_base_url')).replace(/\/$/, ''),
  odoo_db:                  req(input, 'odoo_db'),
  odoo_username:            req(input, 'odoo_username'),
  odoo_api_key_or_password: String(req(input, 'odoo_api_key_or_password')).trim(),
  // Sizing — increase page_limit for faster extraction, decrease for less memory pressure.
  // 200 is the recommended default balancing API stability and throughput.
  page_limit:               Math.max(25, n(input.page_limit, 200)),
  // How many rows to read per source model when harvesting cross-reference IDs.
  // Increase to get more complete partner/product sets; decrease to speed up cold start.
  cross_ref_sample_limit:   Math.max(1000, n(input.cross_ref_sample_limit, 50000)),
  output_root:              String(input.output_root || '/home/node/.n8n/odoo_forensic_exports').replace(/\/$/, ''),
  max_anomaly_evidence_rows: Math.max(25, n(input.max_anomaly_evidence_rows, 500)),
};
if (!cfg.company_context_ids.includes(cfg.target_company_id)) {
  cfg.company_context_ids.unshift(cfg.target_company_id);
}

const started   = new Date().toISOString();
const stage     = '05_master_data';
const base      = `${cfg.output_root}/${cfg.snapshot_id}/${stage}`;
const sanBase   = `${cfg.output_root}/${cfg.snapshot_id}/03_sanitise_profile/sanitised`;

for (const d of ['raw', 'metrics', 'anomalies', 'manifests']) mkdir(path.join(base, d));

// ─── Runtime state ────────────────────────────────────────────────────────────

const outputFiles     = [];
const apiErrors       = [];
const warnings        = [];
const counts          = {};
const statuses        = {};
const fieldsCoverage  = {};
const anomalies       = [];
const anomalyCounts   = {};
const blocked         = [];

// Cross-reference sets harvested from Stage 01/02 sanitised JSONL files
const xref = {
  partner_ids:  new Set(),
  product_ids:  new Set(),
  user_ids:     new Set(),
  tmpl_ids:     new Set(),
  picking_ids:  new Set(), // harvested from stock.picking — used to expand stock.move domain
};

// Stage 05 metrics
const metrics = {
  stage,
  model_counts:       {},
  stock: {
    move_count:           0,
    valuation_total:      0,
    valuation_by_month:   {},
    move_qty_by_month:    {},
  },
  mail: {
    message_count_by_model: {},
    tracking_value_count_by_field: {},
  },
  attachment: {
    count_by_res_model:   {},
  },
  cross_ref: {
    partner_ids_harvested: 0,
    product_ids_harvested: 0,
    user_ids_harvested:    0,
    tmpl_ids_harvested:    0,
  },
  anomaly_counts: {},
};

function addAnomaly(severity, type, message, evidence) {
  metrics.anomaly_counts[type] = (metrics.anomaly_counts[type] || 0) + 1;
  anomalyCounts[type] = (anomalyCounts[type] || 0) + 1;
  if (anomalies.length < cfg.max_anomaly_evidence_rows) {
    anomalies.push({ severity, type, message, evidence });
  }
}

// ─── Odoo JSON-RPC ────────────────────────────────────────────────────────────

async function rpc(service, method, args) {
  const body = {
    jsonrpc: '2.0', method: 'call',
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
  try { j = JSON.parse(text); } catch (e) {
    throw new Error(`Non-JSON Odoo response HTTP ${res.status}: ${text.slice(0, 500)}`);
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
    cfg.odoo_db, cfg.odoo_username, cfg.odoo_api_key_or_password, {},
  ]);
  if (!uid || typeof uid !== 'number') throw new Error(`Odoo auth failed. uid=${JSON.stringify(uid)}`);
  return uid;
}

async function kw(uid, model, method, args = [], kwargs = {}) {
  return await rpc('object', 'execute_kw', [
    cfg.odoo_db, uid, cfg.odoo_api_key_or_password, model, method, args, kwargs,
  ]);
}

const ctx = {
  allowed_company_ids: cfg.company_context_ids,
  company_id:          cfg.target_company_id,
  active_test:         false,
  lang:                'en_AU',
  tz:                  cfg.timezone,
};

// ─── Cross-reference harvesting from Stage 01/02 sanitised JSONL ──────────────
// Reads local sanitised files (no network call) to collect referenced IDs so
// domain-scoped models (res.partner, product.product, res.users) only extract
// records actually referenced by the audit dataset.

function readJsonlIds(filePath, fieldNames, limit) {
  const collected = new Set();
  if (!fs.existsSync(filePath)) return collected;
  let count = 0;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    if (count >= limit) break;
    count++;
    try {
      const row = JSON.parse(line);
      for (const f of fieldNames) {
        const raw = row[f];
        // Many2one flat: stored as _id suffix after flatten
        const id = typeof raw === 'number' ? raw : relId(raw);
        if (typeof id === 'number' && id > 0) collected.add(id);
      }
    } catch { /* skip malformed line */ }
  }
  return collected;
}

function collectCrossRefs() {
  const lim = cfg.cross_ref_sample_limit;

  // Stage 01 sanitised dir
  const s01 = path.join(sanBase, '01_account_ledger');
  // Stage 02 sanitised dir
  const s02 = path.join(sanBase, '02_pos_retail');

  // Partner IDs from AML, move, payment
  for (const [dir, file, fields] of [
    [s01, 'account.move.line.sanitised.jsonl',   ['partner_id_id', 'partner_id']],
    [s01, 'account.move.sanitised.jsonl',         ['partner_id_id', 'partner_id']],
    [s01, 'account.payment.sanitised.jsonl',      ['partner_id_id', 'partner_id']],
    [s01, 'account.bank.statement.line.sanitised.jsonl', ['partner_id_id', 'partner_id']],
    [s02, 'pos.order.sanitised.jsonl',            ['partner_id_id', 'partner_id']],
  ]) {
    const fp = path.join(dir, file);
    for (const id of readJsonlIds(fp, fields, lim)) xref.partner_ids.add(id);
  }

  // Product IDs from AML and POS lines
  for (const [dir, file, fields] of [
    [s01, 'account.move.line.sanitised.jsonl',  ['product_id_id', 'product_id']],
    [s02, 'pos.order.line.sanitised.jsonl',     ['product_id_id', 'product_id']],
  ]) {
    const fp = path.join(dir, file);
    for (const id of readJsonlIds(fp, fields, lim)) xref.product_ids.add(id);
  }

  // User IDs from create_uid / write_uid on high-value models
  for (const [dir, file, fields] of [
    [s01, 'account.move.sanitised.jsonl',       ['create_uid', 'write_uid']],
    [s01, 'account.payment.sanitised.jsonl',    ['create_uid', 'write_uid']],
    [s02, 'pos.order.sanitised.jsonl',          ['create_uid', 'write_uid', 'user_id']],
  ]) {
    const fp = path.join(dir, file);
    for (const id of readJsonlIds(fp, fields, lim)) xref.user_ids.add(id);
  }

  metrics.cross_ref.partner_ids_harvested = xref.partner_ids.size;
  metrics.cross_ref.product_ids_harvested = xref.product_ids.size;
  metrics.cross_ref.user_ids_harvested    = xref.user_ids.size;

  warnings.push(
    `Cross-ref harvest: ${xref.partner_ids.size} partners, ${xref.product_ids.size} products, ${xref.user_ids.size} users`
  );
}

// ─── Binary-field blocklist (never extracted) ─────────────────────────────────
const BINARY_FIELD_TYPES = new Set(['binary']);
const BINARY_FIELD_NAMES = new Set([
  'datas', 'db_datas', 'raw', 'store_fname', 'file_size_base64',
  'image', 'image_128', 'image_256', 'image_512', 'image_1920',
  'image_medium', 'image_small', 'sheet', 'xls_file', 'pdf_file',
]);

function isBinary(fieldName, fieldDef) {
  return BINARY_FIELD_NAMES.has(fieldName) || BINARY_FIELD_TYPES.has(fieldDef?.type);
}

// ─── Model registry ───────────────────────────────────────────────────────────
// Each entry: { model, guarded, domainFn, dateFn, fields[] }
// domainFn(available) → domain array (called after fields_get)
// guarded = true → access-denied errors are non-fatal (logged to api_errors.json)

function sharedCompanyDomain(available) {
  if (!available.has('company_id')) return [];
  return ['|', ['company_id', '=', false], ['company_id', 'in', cfg.company_context_ids]];
}

function strictCompanyDomain(available) {
  if (!available.has('company_id')) return [];
  return [['company_id', '=', cfg.target_company_id]];
}

function fyDomain(dateField) {
  return (available) => {
    if (!available.has(dateField)) return [];
    return [[dateField, '>=', cfg.date_start], [dateField, '<=', cfg.date_end]];
  };
}

function crossRefDomain(idSet, idField, fallbackDomainFn) {
  return (available) => {
    if (idSet.size > 0) {
      return [[idField, 'in', [...idSet]]];
    }
    // fallback to company domain if cross-ref empty
    return fallbackDomainFn(available);
  };
}

// Models are processed in order. Priority ordering: small lookups first (fast),
// then cross-ref dependent models, then date-scoped transaction models, then
// audit trail, then guarded IR tables.
const MODEL_REGISTRY = [
  // ── Priority 1a: Tiny lookup tables (no domain filter needed) ───────────────
  {
    model: 'res.company',
    guarded: false,
    fields: ['id', 'name', 'currency_id', 'country_id', 'vat', 'phone', 'email',
             'street', 'city', 'zip', 'partner_id', 'company_registry', 'create_date'],
    domainFn: () => [['id', '=', cfg.target_company_id]],
  },
  {
    model: 'res.currency',
    guarded: false,
    fields: ['id', 'name', 'symbol', 'rate', 'active', 'create_date'],
    domainFn: () => [],
  },
  {
    model: 'product.category',
    guarded: false,
    fields: ['id', 'name', 'parent_id', 'complete_name',
             'property_cost_method', 'property_valuation',
             'property_account_income_categ_id', 'property_account_expense_categ_id',
             'create_date', 'write_date'],
    domainFn: () => [],
  },
  {
    model: 'uom.uom',
    guarded: false,
    fields: ['id', 'name', 'category_id', 'uom_type', 'factor', 'rounding', 'active', 'create_date'],
    domainFn: () => [],
  },
  {
    model: 'stock.location',
    guarded: false,
    fields: ['id', 'name', 'complete_name', 'usage', 'location_id', 'company_id',
             'active', 'create_date'],
    domainFn: sharedCompanyDomain,
  },
  {
    model: 'stock.warehouse',
    guarded: false,
    fields: ['id', 'name', 'code', 'company_id', 'partner_id', 'lot_stock_id',
             'view_location_id', 'create_date'],
    domainFn: strictCompanyDomain,
  },
  // ── Priority 1b: Tax/fiscal config ─────────────────────────────────────────
  {
    model: 'account.tax.repartition.line',
    guarded: false,
    fields: ['id', 'factor_percent', 'repartition_type', 'account_id', 'tag_ids',
             'company_id', 'invoice_tax_id', 'refund_tax_id', 'create_date'],
    domainFn: strictCompanyDomain,
  },
  {
    model: 'account.fiscal.position',
    guarded: false,
    fields: ['id', 'name', 'active', 'auto_apply', 'vat_required', 'company_id',
             'country_id', 'state_ids', 'create_date'],
    domainFn: strictCompanyDomain,
  },
  {
    model: 'account.payment.term',
    guarded: false,
    fields: ['id', 'name', 'active', 'note', 'line_ids', 'create_date'],
    domainFn: (available) => {
      if (!available.has('company_id')) return [];
      return sharedCompanyDomain(available);
    },
  },
  // ── Priority 1c: Cross-referenced master data ───────────────────────────────
  {
    model: 'res.partner',
    guarded: false,
    fields: ['id', 'name', 'company_id', 'commercial_partner_id', 'parent_id',
             'customer_rank', 'supplier_rank', 'is_company', 'vat', 'active',
             'country_id', 'state_id', 'email', 'phone', 'mobile',
             'create_date', 'write_date'],
    domainFn: (available) => {
      const companyPart = sharedCompanyDomain(available);
      if (xref.partner_ids.size === 0) return companyPart;
      // company_id in [4,false] OR id in referenced_ids
      if (companyPart.length === 0) return [['id', 'in', [...xref.partner_ids]]];
      return ['|', ...companyPart, ['id', 'in', [...xref.partner_ids]]];
    },
  },
  {
    model: 'res.users',
    guarded: false,
    fields: ['id', 'name', 'login', 'email', 'active', 'company_id',
             'share', 'create_date', 'write_date'],
    domainFn: (available) => {
      const companyPart = sharedCompanyDomain(available);
      if (xref.user_ids.size === 0) return companyPart;
      if (companyPart.length === 0) return [['id', 'in', [...xref.user_ids]]];
      return ['|', ...companyPart, ['id', 'in', [...xref.user_ids]]];
    },
  },
  {
    model: 'product.product',
    guarded: false,
    fields: ['id', 'name', 'categ_id', 'product_tmpl_id', 'uom_id', 'uom_po_id',
             'default_code', 'barcode', 'active', 'type', 'company_id',
             'standard_price', 'list_price', 'create_date', 'write_date'],
    domainFn: (available) => {
      if (xref.product_ids.size > 0) return [['id', 'in', [...xref.product_ids]]];
      return sharedCompanyDomain(available);
    },
  },
  {
    model: 'product.template',
    guarded: false,
    fields: ['id', 'name', 'categ_id', 'company_id', 'type', 'active',
             'standard_price', 'list_price', 'uom_id', 'uom_po_id',
             'taxes_id', 'supplier_taxes_id',
             'property_account_income_id', 'property_account_expense_id',
             'description', 'create_date', 'write_date'],
    domainFn: (available) => {
      if (xref.tmpl_ids.size > 0) return [['id', 'in', [...xref.tmpl_ids]]];
      return sharedCompanyDomain(available);
    },
  },
  // ── Priority 2: Stock / COGS ─────────────────────────────────────────────────
  // stock.picking MUST come before stock.move so picking IDs are available for
  // cross-reference domain expansion on stock.move.
  {
    model: 'stock.picking',
    guarded: false,
    fields: ['id', 'name', 'picking_type_id', 'partner_id', 'origin',
             'state', 'date_done', 'scheduled_date', 'company_id',
             'location_id', 'location_dest_id',
             'create_uid', 'create_date', 'write_date'],
    domainFn: (available) => {
      const d = strictCompanyDomain(available);
      const fy = fyDomain('date_done')(available);
      return [...d, ...fy];
    },
    onRecord: (row) => { xref.picking_ids.add(row.id); },
  },
  {
    model: 'stock.move',
    guarded: false,
    fields: ['id', 'name', 'product_id', 'product_uom', 'product_uom_qty',
             'quantity_done', 'date', 'origin', 'picking_id', 'picking_type_id',
             'location_id', 'location_dest_id', 'state', 'company_id',
             'account_move_ids', 'price_unit',
             'create_uid', 'create_date', 'write_date'],
    // Extend beyond simple FY date filter: also include all moves belonging to
    // FY pickings (picking_id in harvested picking IDs) to capture moves whose
    // own date falls slightly outside the FY window (backdated / adjusted moves).
    domainFn: (available) => {
      const d = strictCompanyDomain(available);
      const fyMoves = fyDomain('date')(available);
      if (xref.picking_ids.size > 0 && available.has('picking_id') && fyMoves.length === 2) {
        // Odoo prefix OR: '|' takes next 2 expressions.
        // '&' groups both FY date conditions into a single OR operand.
        // Result: company=4 AND ((date>=start AND date<=end) OR picking_id in ids)
        return [...d, '|', '&', ...fyMoves, ['picking_id', 'in', [...xref.picking_ids]]];
      }
      return [...d, ...fyMoves];
    },
  },
  {
    model: 'stock.move.line',
    guarded: false,
    fields: ['id', 'move_id', 'product_id', 'product_uom_id', 'qty_done',
             'lot_id', 'location_id', 'location_dest_id', 'picking_id',
             'state', 'date', 'company_id', 'create_date', 'write_date'],
    domainFn: (available) => {
      const d = strictCompanyDomain(available);
      const fy = fyDomain('date')(available);
      return [...d, ...fy];
    },
  },
  {
    model: 'stock.valuation.layer',
    guarded: false,
    fields: ['id', 'product_id', 'quantity', 'unit_cost', 'value',
             'stock_move_id', 'account_move_id', 'company_id',
             'description', 'create_date'],
    domainFn: (available) => {
      const d = strictCompanyDomain(available);
      const fy = fyDomain('create_date')(available);
      return [...d, ...fy];
    },
  },
  // ── Source documents ────────────────────────────────────────────────────────
  {
    model: 'sale.order',
    guarded: false,
    fields: ['id', 'name', 'partner_id', 'date_order', 'state',
             'amount_untaxed', 'amount_tax', 'amount_total',
             'company_id', 'user_id', 'currency_id',
             'invoice_ids', 'invoice_status',
             'create_uid', 'create_date', 'write_date'],
    domainFn: (available) => {
      const d = strictCompanyDomain(available);
      const fy = fyDomain('date_order')(available);
      return [...d, ...fy];
    },
  },
  {
    model: 'sale.order.line',
    guarded: false,
    fields: ['id', 'order_id', 'product_id', 'name', 'product_uom_qty',
             'product_uom', 'price_unit', 'discount',
             'price_subtotal', 'price_tax', 'price_total',
             'qty_invoiced', 'qty_delivered', 'invoice_status',
             'create_date', 'write_date'],
    // Use order_id domain indirectly — join filtering happens at extract time via a domain check
    domainFn: (available) => {
      // We cannot domain on order_id.company_id directly in search_read; instead we
      // scope by create_date as a proxy, then post-filter if needed.
      if (!available.has('create_date')) return [];
      return [['create_date', '>=', cfg.date_start], ['create_date', '<=', cfg.date_end]];
    },
  },
  {
    model: 'purchase.order',
    guarded: false,
    fields: ['id', 'name', 'partner_id', 'date_order', 'state',
             'amount_untaxed', 'amount_tax', 'amount_total',
             'company_id', 'user_id', 'currency_id',
             'invoice_ids', 'invoice_status',
             'create_uid', 'create_date', 'write_date'],
    domainFn: (available) => {
      const d = strictCompanyDomain(available);
      const fy = fyDomain('date_order')(available);
      return [...d, ...fy];
    },
  },
  {
    model: 'purchase.order.line',
    guarded: false,
    fields: ['id', 'order_id', 'product_id', 'name', 'product_qty',
             'product_uom', 'price_unit', 'taxes_id',
             'price_subtotal', 'price_tax', 'price_total',
             'qty_invoiced', 'qty_received',
             'date_planned', 'create_date', 'write_date'],
    domainFn: (available) => {
      if (!available.has('create_date')) return [];
      return [['create_date', '>=', cfg.date_start], ['create_date', '<=', cfg.date_end]];
    },
  },
  // ── Priority 3: Audit trail ──────────────────────────────────────────────────
  {
    // mail.message: res_model is stored but NOT searchable as a domain field on all
    // Odoo versions (raises "Invalid field" error). Scope by date only and filter
    // by model at analysis time. guarded=true because some Odoo setups restrict
    // mail.message reads to specific groups.
    model: 'mail.message',
    guarded: true,
    fields: ['id', 'res_id', 'res_model', 'message_type', 'subtype_id',
             'author_id', 'partner_ids', 'body',
             'date', 'create_date', 'write_date'],
    domainFn: (available) => {
      if (available.has('date')) {
        return [['date', '>=', cfg.date_start], ['date', '<=', cfg.date_end]];
      }
      if (available.has('create_date')) {
        return [['create_date', '>=', cfg.date_start], ['create_date', '<=', cfg.date_end]];
      }
      return [];
    },
  },
  {
    // mail.tracking.value requires Administration/Settings group — guarded.
    model: 'mail.tracking.value',
    guarded: true,
    fields: ['id', 'mail_message_id', 'field_id', 'field_desc', 'field_type',
             'old_value_char', 'new_value_char',
             'old_value_integer', 'new_value_integer',
             'old_value_float', 'new_value_float',
             'old_value_datetime', 'new_value_datetime',
             'currency_id', 'create_date'],
    domainFn: (available) => {
      // Scope by create_date within FY — mail.message IDs join happens at analysis time
      if (!available.has('create_date')) return [];
      return [['create_date', '>=', cfg.date_start], ['create_date', '<=', cfg.date_end]];
    },
  },
  {
    model: 'ir.attachment',
    guarded: false,
    // Explicitly exclude all binary fields — metadata only
    fields: ['id', 'res_id', 'res_model', 'res_name', 'name', 'mimetype',
             'file_size', 'type', 'url',
             'create_uid', 'create_date', 'write_date'],
    domainFn: (available) => {
      const auditModels = [
        'account.move', 'account.payment', 'account.bank.statement.line',
        'pos.order', 'sale.order', 'purchase.order',
        'stock.picking', 'res.partner', 'product.template',
      ];
      return [['res_model', 'in', auditModels]];
    },
  },
  // ── Stage 06 placeholder: Guarded IR / technical metadata ───────────────────
  // Access-denied models write to api_errors.json and do NOT fail the workflow.
  {
    model: 'ir.model',
    guarded: true,
    fields: ['id', 'name', 'model', 'state', 'transient', 'create_date'],
    domainFn: () => [],
  },
  {
    model: 'ir.model.fields',
    guarded: true,
    fields: ['id', 'name', 'model_id', 'field_description', 'ttype',
             'relation', 'required', 'readonly', 'store', 'create_date'],
    domainFn: () => [],
  },
  {
    model: 'ir.module.module',
    guarded: true,
    fields: ['id', 'name', 'shortdesc', 'state', 'installed_version',
             'latest_version', 'author', 'website', 'create_date'],
    domainFn: () => [['state', '=', 'installed']],
  },
  {
    model: 'ir.rule',
    guarded: true,
    fields: ['id', 'name', 'model_id', 'active', 'global', 'groups',
             'domain_force', 'perm_read', 'perm_write', 'perm_create', 'perm_unlink'],
    domainFn: () => [],
  },
  {
    model: 'ir.model.access',
    guarded: true,
    fields: ['id', 'name', 'model_id', 'group_id', 'active',
             'perm_read', 'perm_write', 'perm_create', 'perm_unlink'],
    domainFn: () => [],
  },
  {
    model: 'ir.property',
    guarded: true,
    fields: ['id', 'name', 'fields_id', 'company_id', 'res_id', 'value_text',
             'value_float', 'value_integer', 'value_binary', 'type'],
    domainFn: strictCompanyDomain,
  },
];

// ─── Flatten Many2one fields ──────────────────────────────────────────────────

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

// ─── Per-record metric tracking ───────────────────────────────────────────────

function trackStockMove(row) {
  metrics.stock.move_count++;
  const qty = Number(row.quantity_done || row.product_uom_qty || 0);
  const m = month(row.date);
  if (!metrics.stock.move_qty_by_month[m]) metrics.stock.move_qty_by_month[m] = 0;
  metrics.stock.move_qty_by_month[m] += qty;
}

function trackValuationLayer(row) {
  const val = Number(row.value || 0);
  metrics.stock.valuation_total += val;
  const m = month(row.create_date);
  if (!metrics.stock.valuation_by_month[m]) metrics.stock.valuation_by_month[m] = 0;
  metrics.stock.valuation_by_month[m] += val;

  if (!row.stock_move_id && !relId(row.stock_move_id)) {
    addAnomaly('medium', 'valuation_layer_missing_stock_move',
      'Stock valuation layer has no stock_move_id', {
        id: row.id,
        product_id: relId(row.product_id),
        value: val,
        create_date: row.create_date,
      });
  }
  if (!row.account_move_id && !relId(row.account_move_id) && Math.abs(val) > 0.01) {
    addAnomaly('high', 'valuation_layer_missing_account_move',
      'Stock valuation layer with non-zero value has no account_move_id', {
        id: row.id,
        product_id: relId(row.product_id),
        value: val,
        create_date: row.create_date,
      });
  }
}

function trackMailMessage(row) {
  const resModel = row.res_model || 'unknown';
  metrics.mail.message_count_by_model[resModel] =
    (metrics.mail.message_count_by_model[resModel] || 0) + 1;
}

function trackTrackingValue(row) {
  const field = row.field_desc || row.field_id_label || String(relId(row.field_id) || 'unknown');
  metrics.mail.tracking_value_count_by_field[field] =
    (metrics.mail.tracking_value_count_by_field[field] || 0) + 1;

  // Post-period tracking on financial fields is a high-interest anomaly
  const sensitiveFields = ['amount_total', 'amount_tax', 'invoice_date', 'date',
                           'partner_id', 'account_id', 'journal_id', 'payment_state'];
  if (sensitiveFields.some(f => String(field).toLowerCase().includes(f))) {
    const createDate = row.create_date || '';
    if (createDate > cfg.date_end) {
      addAnomaly('high', 'post_fy_tracking_on_financial_field',
        `Field ${field} changed after FY end (${createDate})`, {
          id: row.id,
          field_desc: field,
          old_value: row.old_value_char || row.old_value_float,
          new_value: row.new_value_char || row.new_value_float,
          create_date: createDate,
        });
    }
  }
}

function trackAttachment(row) {
  const resModel = row.res_model || 'unknown';
  metrics.attachment.count_by_res_model[resModel] =
    (metrics.attachment.count_by_res_model[resModel] || 0) + 1;
}

// ─── Generic model exporter ───────────────────────────────────────────────────

async function exportModel(uid, mc) {
  statuses[mc.model] = 'started';
  try {
    const fg = await kw(uid, mc.model, 'fields_get', [], { attributes: ['string', 'type', 'relation', 'store'] });
    const available = new Set(Object.keys(fg || {}));

    // Build requested fields: filter against available and strip binary fields
    const requested = ['id', ...mc.fields.filter(f => f !== 'id')];
    const selected = requested.filter(f => available.has(f) && !isBinary(f, fg[f]));
    const missing = requested.filter(f => f !== 'id' && !available.has(f));

    const domain = mc.domainFn(available);

    fieldsCoverage[mc.model] = {
      selected_fields: selected,
      missing_requested_fields: missing,
      binary_stripped: requested.filter(f => isBinary(f, fg[f])),
      domain,
    };
    if (missing.length) warnings.push(`${mc.model}: missing requested fields: ${missing.join(', ')}`);
    write(path.join(base, 'manifests', `${safe(mc.model)}_field_coverage.json`), fieldsCoverage[mc.model]);

    let count = 0;
    try {
      count = await kw(uid, mc.model, 'search_count', [domain], { context: ctx });
    } catch (e) {
      apiErrors.push({ model: mc.model, method: 'search_count', error: e.message, domain, guarded: !!mc.guarded });
      statuses[mc.model] = 'failed_count';
      return;
    }
    counts[mc.model] = count;
    metrics.model_counts[mc.model] = count;

    const rawFile = path.join(base, 'raw', `${safe(mc.model)}.jsonl`);
    if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);

    // Paginate through all records
    for (let offset = 0; offset < count; offset += cfg.page_limit) {
      let rows;
      try {
        rows = await kw(uid, mc.model, 'search_read', [domain], {
          fields: selected.filter(f => f !== 'id'),
          offset,
          limit: cfg.page_limit,
          order: 'id asc',
          context: ctx,
        });
      } catch (e) {
        apiErrors.push({
          model: mc.model, method: 'search_read', offset,
          limit: cfg.page_limit, error: e.message, domain, guarded: !!mc.guarded,
        });
        statuses[mc.model] = 'partial_search_read_failure';
        break;
      }

      const enriched = rows.map(r => ({
        ...flatten(r),
        _export: {
          snapshot_id:          cfg.snapshot_id,
          subworkflow:          stage,
          model:                mc.model,
          model_slug:           safe(mc.model),
          offset,
          limit:                cfg.page_limit,
          exported_at:          new Date().toISOString(),
          source_company_context: cfg.company_context_ids,
          target_company_id:    cfg.target_company_id,
        },
      }));

      appendJsonl(rawFile, enriched);
      if (!outputFiles.includes(rawFile)) outputFiles.push(rawFile);

      // Per-record metric tracking + optional model-level onRecord hook
      for (const row of enriched) {
        if (mc.model === 'stock.move')              trackStockMove(row);
        if (mc.model === 'stock.valuation.layer')   trackValuationLayer(row);
        if (mc.model === 'mail.message')            trackMailMessage(row);
        if (mc.model === 'mail.tracking.value')     trackTrackingValue(row);
        if (mc.model === 'ir.attachment')           trackAttachment(row);
        if (mc.onRecord) mc.onRecord(row);
      }

      // Harvest product template IDs from product.product so product.template domain is precise
      if (mc.model === 'product.product') {
        for (const row of enriched) {
          const tmplId = relId(row.product_tmpl_id);
          if (typeof tmplId === 'number' && tmplId > 0) xref.tmpl_ids.add(tmplId);
        }
      }
    }

    if (!String(statuses[mc.model]).includes('partial') && statuses[mc.model] !== 'failed_count') {
      statuses[mc.model] = 'success';
    }
  } catch (e) {
    apiErrors.push({ model: mc.model, method: 'exportModel', error: e.message, guarded: !!mc.guarded });
    statuses[mc.model] = mc.guarded ? 'access_denied' : 'failed';
  }
}

// Guarded wrapper: non-fatal on any error for guarded models
async function guardedExport(uid, mc) {
  if (!mc.guarded) return exportModel(uid, mc);
  try {
    await exportModel(uid, mc);
  } catch (e) {
    apiErrors.push({ model: mc.model, method: 'guarded', error: e.message, guarded: true });
    statuses[mc.model] = 'access_denied';
  }
}

// ─── Post-extract anomaly checks ─────────────────────────────────────────────

function runPostAnomalies() {
  // Referenced partners not present in res.partner
  if (statuses['res.partner'] === 'success' && xref.partner_ids.size > 0) {
    const rawFile = path.join(base, 'raw', 'res_partner.jsonl');
    if (fs.existsSync(rawFile)) {
      const extracted = new Set();
      const buf = fs.readFileSync(rawFile, 'utf8');
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r.id) extracted.add(r.id); } catch {}
      }
      const missing = [...xref.partner_ids].filter(id => !extracted.has(id));
      if (missing.length > 0) {
        addAnomaly('medium', 'referenced_partner_missing',
          `${missing.length} partner IDs referenced in Stage 01/02 not present in extracted res.partner`, {
            missing_count: missing.length,
            sample_missing_ids: missing.slice(0, 20),
          });
      }
    }
  }

  // Referenced products not present in product.product
  if (statuses['product.product'] === 'success' && xref.product_ids.size > 0) {
    const rawFile = path.join(base, 'raw', 'product_product.jsonl');
    if (fs.existsSync(rawFile)) {
      const extracted = new Set();
      const buf = fs.readFileSync(rawFile, 'utf8');
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r.id) extracted.add(r.id); } catch {}
      }
      const missing = [...xref.product_ids].filter(id => !extracted.has(id));
      if (missing.length > 0) {
        addAnomaly('medium', 'referenced_product_missing',
          `${missing.length} product IDs referenced in Stage 01/02 not present in extracted product.product`, {
            missing_count: missing.length,
            sample_missing_ids: missing.slice(0, 20),
          });
      }
    }
  }

  // Referenced users not present in res.users
  if (statuses['res.users'] === 'success' && xref.user_ids.size > 0) {
    const rawFile = path.join(base, 'raw', 'res_users.jsonl');
    if (fs.existsSync(rawFile)) {
      const extracted = new Set();
      const buf = fs.readFileSync(rawFile, 'utf8');
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r.id) extracted.add(r.id); } catch {}
      }
      const missing = [...xref.user_ids].filter(id => !extracted.has(id));
      if (missing.length > 0) {
        addAnomaly('low', 'referenced_user_missing',
          `${missing.length} user IDs referenced in Stage 01/02 not present in extracted res.users`, {
            missing_count: missing.length,
            sample_missing_ids: missing.slice(0, 10),
          });
      }
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function roundObject(o) {
  for (const k of Object.keys(o)) {
    if (typeof o[k] === 'number') o[k] = round2(o[k]);
    else if (o[k] && typeof o[k] === 'object') roundObject(o[k]);
  }
}

async function main() {
  // Step 1: Harvest cross-reference IDs from existing Stage 01/02 sanitised files
  collectCrossRefs();

  const uid = await authenticate();

  // Step 2: Export all models in registry order
  for (const mc of MODEL_REGISTRY) {
    await guardedExport(uid, mc);
  }

  // Step 3: Post-extract anomaly cross-checks
  runPostAnomalies();

  // Step 4: Round all metric floats
  roundObject(metrics);
  metrics.stock.valuation_total = round2(metrics.stock.valuation_total);

  // Step 5: Determine blocked conclusions
  const coreModels = ['res.partner', 'product.product', 'product.template', 'res.users'];
  for (const m of coreModels) {
    if (statuses[m] !== 'success') {
      blocked.push(`Partner/product/user analysis blocked: ${m} status=${statuses[m] || 'not_attempted'}`);
    }
  }
  const stockModels = ['stock.move', 'stock.valuation.layer'];
  for (const m of stockModels) {
    if (statuses[m] !== 'success') {
      blocked.push(`COGS/stock analysis blocked: ${m} status=${statuses[m] || 'not_attempted'}`);
    }
  }

  // Step 6: Write output files
  const metricFile  = path.join(base, 'metrics/master_data_metric_pack.json');
  const anomalyFile = path.join(base, 'anomalies/master_data_anomaly_pack.json');
  const resultFile  = path.join(base, 'manifests/subworkflow_result.json');

  write(metricFile, metrics);
  write(anomalyFile, { anomaly_counts: anomalyCounts, anomalies, blocked_metrics: blocked });
  write(path.join(base, 'manifests/model_counts.json'),  counts);
  write(path.join(base, 'manifests/api_errors.json'),    apiErrors);
  write(path.join(base, 'manifests/warnings.json'),      warnings);
  write(path.join(base, 'manifests/field_coverage.json'), fieldsCoverage);
  write(path.join(base, 'manifests/cross_ref_summary.json'), {
    partner_ids_harvested: xref.partner_ids.size,
    product_ids_harvested: xref.product_ids.size,
    user_ids_harvested:    xref.user_ids.size,
    tmpl_ids_harvested:    xref.tmpl_ids.size,
    page_limit_used:       cfg.page_limit,
    cross_ref_sample_limit: cfg.cross_ref_sample_limit,
  });

  const accessDenied = Object.entries(statuses)
    .filter(([, s]) => s === 'access_denied')
    .map(([m]) => m);

  const result = {
    subworkflow:       '05_SUB_MASTER_DATA',
    status:            apiErrors.filter(e => !e.guarded).length ? 'partial' : 'success',
    snapshot_id:       cfg.snapshot_id,
    company_id:        cfg.target_company_id,
    period:            `${cfg.date_start} to ${cfg.date_end}`,
    started_at:        started,
    completed_at:      new Date().toISOString(),
    page_limit_used:   cfg.page_limit,
    models_attempted:  MODEL_REGISTRY.map(m => m.model),
    models_exported:   Object.entries(statuses).filter(([, s]) => s === 'success').map(([m]) => m),
    access_denied_models: accessDenied,
    records_exported:  counts,
    api_errors:        apiErrors,
    warnings,
    anomaly_counts:    anomalyCounts,
    blocked_metrics:   blocked,
    metric_pack_path:  metricFile,
    anomaly_pack_path: anomalyFile,
    output_base:       base,
    output_files:      outputFiles,
    cross_ref_summary: {
      partner_ids_harvested: xref.partner_ids.size,
      product_ids_harvested: xref.product_ids.size,
      user_ids_harvested:    xref.user_ids.size,
      tmpl_ids_harvested:    xref.tmpl_ids.size,
    },
    sizing_recommendation: {
      page_limit_used: cfg.page_limit,
      note: 'For fastest full extraction with stable memory: page_limit=200 (default). Increase to 500 only on fast low-latency Odoo instances. Decrease to 50 if extraction times out on stock.move or mail.message.',
    },
    summary: {
      total_models_attempted:    MODEL_REGISTRY.length,
      total_models_exported:     Object.values(statuses).filter(s => s === 'success').length,
      total_models_access_denied: accessDenied.length,
      total_records:             Object.values(counts).reduce((a, b) => a + b, 0),
      stock_valuation_total:     metrics.stock.valuation_total,
      stock_move_count:          metrics.stock.move_count,
      mail_message_count:        Object.values(metrics.mail.message_count_by_model).reduce((a, b) => a + b, 0),
      attachment_count:          Object.values(metrics.attachment.count_by_res_model).reduce((a, b) => a + b, 0),
      post_fy_tracking_anomalies: anomalyCounts['post_fy_tracking_on_financial_field'] || 0,
      blocked_metrics:           blocked,
    },
  };

  write(resultFile, result);
  process.stdout.write(JSON.stringify(result));
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
