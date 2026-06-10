const fs = require('fs');
const input = { ...$input.first().json };

const inputPath = '/tmp/odoo_04_claude_input.json';
fs.writeFileSync(inputPath, JSON.stringify(input), 'utf8');

return [{
  json: {
    ok: true,
    input_path: inputPath,
    snapshot_id: input.snapshot_id,
    message: 'Input JSON written for Claude audit prepare',
  },
}];
