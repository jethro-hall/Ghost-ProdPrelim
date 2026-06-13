// Paste into orchestrator Code node: "Build Snapshot Context"
// Runs after Confirm Period — Wait. Creates snapshot_id, writes snapshot_run_context.json.

const fs = require('fs');
const path = require('path');

const cfg = $input.first().json;

function required(name) {
  if (
    cfg[name] === undefined ||
    cfg[name] === null ||
    String(cfg[name]).trim() === '' ||
    String(cfg[name]).startsWith('PUT_') ||
    String(cfg[name]).startsWith('PASTE_')
  ) {
    throw new Error(`Missing required core config: ${name}`);
  }
  return cfg[name];
}

function parseIds(v) {
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  return String(v).split(',').map(x => Number(String(x).trim())).filter(Number.isFinite);
}

function companySlug(name) {
  return String(name || 'unknown')
    .toLowerCase()
    .replace(/^ride electric\s+/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

const now = new Date().toISOString();
const dateStart = String(required('date_start')).trim();
const dateEnd = String(required('date_end')).trim();
const fyEndYear = dateEnd.slice(0, 4);

const targetCompanyId = Number(required('target_company_id'));
const companyName = String(cfg.target_company_name || 'unknown').trim();
const slug = companySlug(companyName);
const ts = now.replace(/[:.]/g, '-');

const snapshotId = cfg.snapshot_id && String(cfg.snapshot_id).trim()
  ? String(cfg.snapshot_id).trim()
  : `eofy_${fyEndYear}_${slug}_c${targetCompanyId}_${ts}`;

const companyContextIds = parseIds(required('company_context_ids'));
if (!companyContextIds.includes(targetCompanyId)) companyContextIds.unshift(targetCompanyId);

const outputRoot = String(cfg.output_root || '/home/node/.n8n/odoo_forensic_exports').replace(/\/$/, '');
const snapRoot = path.join(outputRoot, snapshotId);

fs.mkdirSync(snapRoot, { recursive: true });

const runContext = {
  snapshot_id: snapshotId,
  date_start: dateStart,
  date_end: dateEnd,
  period_label: cfg.period_label ? String(cfg.period_label).trim() : null,
  company_id: targetCompanyId,
  company_name: companyName,
  odoo_db: cfg.odoo_db ? String(cfg.odoo_db).trim() : null,
  timezone: cfg.timezone || 'Australia/Brisbane',
  created_at: now,
};

fs.writeFileSync(
  path.join(snapRoot, 'snapshot_run_context.json'),
  JSON.stringify(runContext, null, 2),
  'utf8',
);

return [{
  json: {
    snapshot_id: snapshotId,
    timezone: cfg.timezone || 'Australia/Brisbane',

    odoo_base_url: String(required('odoo_base_url')).replace(/\/$/, ''),
    odoo_db: required('odoo_db'),
    odoo_username: required('odoo_username'),
    odoo_api_key_or_password: required('odoo_api_key_or_password'),

    target_company_id: targetCompanyId,
    target_company_name: companyName,
    company_context_ids: companyContextIds,

    date_start: dateStart,
    date_end: dateEnd,
    period_label: runContext.period_label,

    output_root: outputRoot,
    page_limit: Number(cfg.page_limit || 500),

    subworkflow_01_account_ledger_id: required('subworkflow_01_account_ledger_id'),
    subworkflow_02_pos_retail_id: cfg.subworkflow_02_pos_retail_id || required('subworkflow_02_pos_retail_id'),

    subworkflow_03_sanitise_profile_id: cfg.subworkflow_03_sanitise_profile_id || required('subworkflow_03_sanitise_profile_id'),
    subworkflow_04_claude_audit_id: cfg.subworkflow_04_claude_audit_id || required('subworkflow_04_claude_audit_id'),
    claude_model: cfg.claude_model || 'claude-sonnet-4-20250514',

    max_anomaly_evidence_rows: Number(cfg.max_anomaly_evidence_rows || 500),
    max_claude_evidence_rows: Number(cfg.max_claude_evidence_rows || 50),

    snapshot_run_context_path: path.join(snapRoot, 'snapshot_run_context.json'),
    period_preview: cfg.period_preview || null,
  },
}];
