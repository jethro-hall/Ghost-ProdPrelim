# Fix: Execute Command does not evaluate `={{ JSON.stringify($json) }}`

## What the error proves

If you see:

```
SyntaxError: Unexpected token '=', "={{ JSON.s"... is not valid JSON
={{ JSON.stringify($json) }}
^
```

the file `/tmp/odoo_01_account_ledger_input.json` literally contains the text `={{ JSON.stringify($json) }}`.

**Execute Command does not evaluate expressions embedded in the middle of a multi-line command.** Inline `={{ ... }}` only works when the **entire Command field** is in expression mode (first character of the field is `=`).

Do not keep fighting the heredoc + expression combo. Use a Code node instead.

## Fix (recommended): Code node writes JSON, Execute Command only runs Node

### Step 1 — Add Code node after `When Executed by Core`

**Name:** `Write exporter input JSON`

```javascript
const fs = require('fs');
const input = { ...$input.first().json };
if (input.odoo_api_key_or_password) {
  input.odoo_api_key_or_password = String(input.odoo_api_key_or_password).trim();
}
fs.writeFileSync('/tmp/odoo_01_account_ledger_input.json', JSON.stringify(input), 'utf8');
return [{ json: { ok: true, snapshot_id: input.snapshot_id } }];
```

### Step 2 — Rewire

```
When Executed by Core → Write exporter input JSON → Run Account Ledger Exporter → Parse Exporter Result
```

### Step 3 — Edit Execute Command: delete the `cat` block

Remove everything from `cat > /tmp/odoo_01_account_ledger_input.json` through the closing `JSON` line.

Command must **start** with:

```bash
node <<'NODE'

const fs = require('fs');
const path = require('path');

const input = JSON.parse(fs.readFileSync('/tmp/odoo_01_account_ledger_input.json', 'utf8'));
```

…rest of script unchanged, ending with:

```bash
NODE
```

### Step 4 — Fix script typo

Before `main().catch`, ensure closing brace is `}` not `}v`:

```javascript
}

main().catch(err => {
```

### Step 5 — Odoo field fix

In the `account.move.line` fields array, **remove** `commercial_partner_id` (invalid on this Odoo).

## Alternative (whole-field expression only)

Only if you refuse a Code node: click **fx** on the Command field so the **entire** value is one expression starting with `=`, e.g. template literal wrapping the full shell script with `${JSON.stringify($json)}` inside. Fragile for large scripts — Code node is better.

## Verify

After `Write exporter input JSON` runs:

```bash
head -c 120 /tmp/odoo_01_account_ledger_input.json
```

Must start with `{"snapshot_id":` not `{{` or `={{`.

## Fix: Parse Exporter Result — `Invalid or unexpected token`

### Symptom

Sub-workflow runs for ~2 minutes (large Odoo pull), export files appear under `odoo_forensic_exports/`, then fails on **Parse Exporter Result** with:

```text
SyntaxError: Invalid or unexpected token
```

### Cause

The **Parse Exporter Result** Code node was saved as **one line containing literal `\n` characters** instead of real line breaks. JavaScript cannot compile that.

### Fix

Open **Parse Exporter Result**, delete all code, and paste from:

`lib/n8n_parse_exporter_result.code.js`

Save, then re-run.

**Do not use `require('fs')` in Code nodes** — n8n 2.x task runners block filesystem access and surface it as `Unknown error` / `ERR_ASSERTION`. Parse stdout from **Run Account Ledger Exporter** instead (the exporter prints JSON on the last line).
