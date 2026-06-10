const ledger = $('Run 01 Sub - Account Ledger').first().json;
const pos = $('Run 02 Sub - POS Retail').first().json;
const sanitise = $('Run 03 Sub - Sanitise Profile').first().json;
const audit = $input.first().json;

const snapshotId =
  audit.snapshot_id ||
  sanitise.snapshot_id ||
  pos.snapshot_id ||
  ledger.snapshot_id;

return [{
  json: {
    snapshot_id: snapshotId,
    stage_01_account_ledger: ledger,
    stage_02_pos_retail: pos,
    stage_03_sanitise_profile: sanitise,
    stage_04_claude_audit: audit,
    core_completed_at: new Date().toISOString(),
    readiness_status: sanitise.readiness_status || null,
    eofy_status: audit.eofy_status || null,
    anomaly_count: audit.anomaly_count || 0,
    report_path: audit.report_path || null,
  },
}];
