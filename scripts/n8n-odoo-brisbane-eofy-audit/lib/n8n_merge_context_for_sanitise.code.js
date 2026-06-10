const ctx = $('Build Snapshot Context').first().json;
const ledger = $('Run 01 Sub - Account Ledger').first().json;
const pos = $('Run 02 Sub - POS Retail').first().json;

return [{
  json: {
    ...ctx,
    snapshot_id: pos.snapshot_id || ledger.snapshot_id || ctx.snapshot_id,
    stage_01_summary: ledger,
    stage_02_summary: pos,
  },
}];
