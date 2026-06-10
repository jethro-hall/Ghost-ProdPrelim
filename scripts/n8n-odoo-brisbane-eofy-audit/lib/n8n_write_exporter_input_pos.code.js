// Paste into n8n Code node: "Write exporter input JSON"
// Place BETWEEN trigger and "Run POS Retail Exporter"

const fs = require('fs');
const input = { ...$input.first().json };

if (!input.target_company_id && input.company_id) {
  input.target_company_id = input.company_id;
}
if (input.odoo_api_key_or_password) {
  input.odoo_api_key_or_password = String(input.odoo_api_key_or_password).trim();
}

const inputPath = '/tmp/odoo_02_pos_retail_input.json';
fs.writeFileSync(inputPath, JSON.stringify(input), 'utf8');

return [{
  json: {
    ok: true,
    input_path: inputPath,
    snapshot_id: input.snapshot_id,
    message: 'Input JSON written for POS retail exporter',
  },
}];
