// Paste into n8n Code node: "Return Core Result" (parent orchestrator)
// AFTER sub-workflow steps complete successfully.

const result = $input.first().json;

return [{
  json: {
    ...result,
    core_completed_at: new Date().toISOString(),
    next_stage: '02_SUB_POS_RETAIL after 01 validates.',
  },
}];
