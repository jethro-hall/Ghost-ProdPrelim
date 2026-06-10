// Paste into n8n Code node: "Parse Exporter Result"
// AFTER "Run Account Ledger Exporter"
//
// Do NOT use require('fs') — n8n task-runner Code nodes block filesystem access.

const item = $input.first().json;

if (item.exitCode !== undefined && Number(item.exitCode) !== 0) {
  throw new Error(
    `Account ledger exporter failed (exit ${item.exitCode}). stderr: ${item.stderr || ''}`,
  );
}

const stdout = String(item.stdout || '').trim();
if (!stdout) {
  throw new Error(
    `Account ledger exporter returned empty stdout. stderr: ${item.stderr || ''}`,
  );
}

const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop();

try {
  return [{ json: JSON.parse(lastLine) }];
} catch (e) {
  throw new Error(
    `Could not parse exporter stdout as JSON: ${e.message}. stdout starts: ${stdout.slice(0, 500)}`,
  );
}
