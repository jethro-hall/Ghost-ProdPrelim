const fs = require('fs');

const prep = $input.first().json;
const inputPath = '/tmp/odoo_04_claude_call_input.json';

fs.writeFileSync(inputPath, JSON.stringify(prep), 'utf8');

return [{
  json: {
    ok: true,
    input_path: inputPath,
    snapshot_id: prep.snapshot_id,
    claude_model: prep.claude_model,
  },
}];
