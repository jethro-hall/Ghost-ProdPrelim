// Paste into orchestrator Code node: "Validate And Preview Period"
// Runs after Select Audit Period — validates dates and outputs a human-readable preview.
// Fail closed before the Wait gate if dates are invalid.

const cfg = { ...$input.first().json };

function required(name) {
  if (
    cfg[name] === undefined ||
    cfg[name] === null ||
    String(cfg[name]).trim() === '' ||
    String(cfg[name]).startsWith('PUT_') ||
    String(cfg[name]).startsWith('PASTE_')
  ) {
    throw new Error(`Missing required period field: ${name}`);
  }
  return String(cfg[name]).trim();
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

const dateStart = required('date_start');
const dateEnd = required('date_end');

if (!isIsoDate(dateStart)) throw new Error(`date_start must be YYYY-MM-DD, got: ${dateStart}`);
if (!isIsoDate(dateEnd)) throw new Error(`date_end must be YYYY-MM-DD, got: ${dateEnd}`);
if (dateStart >= dateEnd) throw new Error(`date_start (${dateStart}) must be before date_end (${dateEnd})`);

const periodLabel = cfg.period_label ? String(cfg.period_label).trim() : '';
const snapshotOverride = cfg.snapshot_id ? String(cfg.snapshot_id).trim() : '';
const fyEndYear = dateEnd.slice(0, 4);
const now = new Date().toISOString();
const companyName = String(cfg.target_company_name || 'unknown').trim();
const slug = String(companyName)
  .toLowerCase()
  .replace(/^ride electric\s+/i, '')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '') || 'unknown';
const companyId = cfg.target_company_id != null ? Number(cfg.target_company_id) : 'x';
const plannedSnapshotId = snapshotOverride
  || `eofy_${fyEndYear}_${slug}_c${companyId}_${now.replace(/[:.]/g, '-')}`;

return [{
  json: {
    ...cfg,
    date_start: dateStart,
    date_end: dateEnd,
    period_label: periodLabel,
    snapshot_id: snapshotOverride,
    period_preview: {
      date_start: dateStart,
      date_end: dateEnd,
      period_label: periodLabel || null,
      fy_end_year: fyEndYear,
      planned_snapshot_id: plannedSnapshotId,
      company_id: cfg.target_company_id,
      company_name: cfg.target_company_name || 'Ride Electric Brisbane',
      message: 'Review period_preview, then Resume this execution to start Odoo extraction.',
      resume_hint: 'Click Resume in the n8n execution panel, or call $execution.resumeUrl',
    },
  },
}];
