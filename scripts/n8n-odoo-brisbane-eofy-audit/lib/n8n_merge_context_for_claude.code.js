const ctx = $('Build Snapshot Context').first().json;
const sanitise = $('Run 03 Sub - Sanitise Profile').first().json;

return [{
  json: {
    snapshot_id: sanitise.snapshot_id || ctx.snapshot_id,
    output_root: ctx.output_root,
    claude_model: ctx.claude_model || 'claude-sonnet-4-20250514',
    max_sample_per_model: Number(ctx.max_claude_evidence_rows || 40),
    readiness_status: sanitise.readiness_status || null,
  },
}];
