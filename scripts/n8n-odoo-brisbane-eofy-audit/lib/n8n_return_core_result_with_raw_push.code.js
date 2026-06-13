const ledger = $('Run 01 Sub - Account Ledger').first().json;
const pos = $('Run 02 Sub - POS Retail').first().json;
const sanitise = $('Run 03 Sub - Sanitise Profile').first().json;
const masterData = $('Run 05 Sub - Master Data').first().json;
const githubPush = $('Run 04 Sub - Claude Audit').first().json;
const rawPush = $input.first().json;

const snapshotId =
  rawPush.snapshot_id ||
  githubPush.snapshot_id ||
  masterData.snapshot_id ||
  sanitise.snapshot_id ||
  pos.snapshot_id ||
  ledger.snapshot_id;

return [{
  json: {
    snapshot_id: snapshotId,
    stage_01_account_ledger: ledger,
    stage_02_pos_retail: pos,
    stage_03_sanitise_profile: sanitise,
    stage_05_master_data: masterData,
    stage_04_github_push: githubPush,
    stage_06_raw_github_push: rawPush,
    core_completed_at: new Date().toISOString(),
    readiness_status: sanitise.readiness_status || null,
    github_audit_package_url: githubPush.audit_exports_url || null,
    opus_entry_point: githubPush.opus_entry_point || null,
    github_raw_data_url: rawPush.raw_data_url || null,
    raw_files_pushed: rawPush.files_pushed || null,
  },
}];
