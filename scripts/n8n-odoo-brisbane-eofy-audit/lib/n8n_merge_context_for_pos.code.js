// Paste into parent orchestrator Code node: "Merge Context for POS"
// BETWEEN "Run 01 Sub - Account Ledger" and "Run 02 Sub - POS Retail"

const ctx = $('Build Snapshot Context').first().json;
const ledger = $('Run 01 Sub - Account Ledger').first().json;

return [{
  json: {
    ...ctx,
    snapshot_id: ledger.snapshot_id || ctx.snapshot_id,
    stage_01_ledger_summary: ledger.summary || null,
  },
}];
