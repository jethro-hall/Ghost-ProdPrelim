const fs = require('fs');

const prep = $('Parse Claude Prepare Result').first().json;
const api = $input.first().json;

const inputPath = '/tmp/odoo_04_claude_save_input.json';
fs.writeFileSync(
  inputPath,
  JSON.stringify({
    snapshot_id: prep.snapshot_id,
    report_root: prep.report_root,
    stage_root: prep.stage_root,
    claude_model: prep.claude_model,
    api_response: api,
  }),
  'utf8',
);

return [{
  json: {
    ok: true,
    input_path: inputPath,
    snapshot_id: prep.snapshot_id,
  },
}];
