// Paste into n8n Code node: "Write exporter input JSON"
// Place BETWEEN "When Executed by Core" and "Run Account Ledger Exporter"

const fs = require('fs');
const input = { ...$input.first().json };

if (input.odoo_api_key_or_password) {
  input.odoo_api_key_or_password = String(input.odoo_api_key_or_password).trim();
}

const inputPath = '/tmp/odoo_01_account_ledger_input.json';
fs.writeFileSync(inputPath, JSON.stringify(input), 'utf8');

return [{
  json: {
    ok: true,
    input_path: inputPath,
    snapshot_id: input.snapshot_id,
    message: 'Input JSON written for account ledger exporter',
  },
}];
