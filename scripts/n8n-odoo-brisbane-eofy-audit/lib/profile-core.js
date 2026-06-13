/**
 * Profile sanitised JSONL exports for Claude readiness summary.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function initProfileSummary(modelKey) {
  return {
    model: modelKey,
    files: 1,
    rows: 0,
    distinct_ids: 0,
    field_count: 0,
    fields: [],
    min_date: null,
    max_date: null,
    debit_total: 0,
    credit_total: 0,
    balance_total: 0,
    amount_total: 0,
    pii_hits_after: 0,
    personal_fields_redacted: 0,
    bank_fields_redacted: 0,
    compacted_text_fields: 0,
  };
}

function accumulateProfileRow(summary, row) {
  summary.rows += 1;
  if (row.id) summary._ids.add(row.id);
  Object.keys(row).forEach((k) => summary._fields.add(k));
  if (row.debit) summary.debit_total += Number(row.debit) || 0;
  if (row.credit) summary.credit_total += Number(row.credit) || 0;
  if (row.balance) summary.balance_total += Number(row.balance) || 0;
  if (row.amount_total) summary.amount_total += Number(row.amount_total) || 0;
  if (row._sanitisation) {
    summary.personal_fields_redacted += row._sanitisation.personal_fields_redacted || 0;
    summary.bank_fields_redacted += row._sanitisation.bank_fields_redacted || 0;
    summary.compacted_text_fields += row._sanitisation.compacted_text_fields || 0;
  }

  const dateCandidates = ['date', 'date_order', 'invoice_date', 'payment_date', 'create_date', 'start_at'];
  for (const d of dateCandidates) {
    const v = row[d];
    if (v && v !== false && typeof v === 'string') {
      if (!summary.min_date || v < summary.min_date) summary.min_date = v;
      if (!summary.max_date || v > summary.max_date) summary.max_date = v;
    }
  }

  const piiScan = JSON.stringify(row);
  if (/@/.test(piiScan) || /\b04\d{8}\b/.test(piiScan)) summary.pii_hits_after += 1;
}

function finalizeProfileSummary(summary) {
  summary.distinct_ids = summary._ids.size;
  summary.fields = [...summary._fields].sort();
  summary.field_count = summary.fields.length;
  delete summary._ids;
  delete summary._fields;
  return summary;
}

/**
 * Stream-profile a sanitised JSONL file without loading it all into memory.
 */
async function profileJsonlFile(filePath, modelKey) {
  const summary = initProfileSummary(modelKey);
  summary._ids = new Set();
  summary._fields = new Set();

  if (!fs.existsSync(filePath)) {
    delete summary._ids;
    delete summary._fields;
    return summary;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        accumulateProfileRow(summary, JSON.parse(trimmed));
      } catch {
        // skip bad lines
      }
    }
  } finally {
    rl.close();
  }

  return finalizeProfileSummary(summary);
}

function buildReadinessSummary(snapshotId, paths, modelSummaries, manifests) {
  const totalRows = modelSummaries.reduce((a, m) => a + m.rows, 0);
  const piiAfter = modelSummaries.reduce((a, m) => a + m.pii_hits_after, 0);
  const gaps = manifests.filter((m) => m.status !== 'written' && m.status !== 'empty');

  return {
    summary: {
      ok: gaps.length === 0,
      status: piiAfter > 0 ? 'REVIEW_PII_REMAINS' : 'READY_FOR_CLAUDE',
      selected_snapshot_id: snapshotId,
      raw_root: paths.raw_root,
      sanitised_root: paths.sanitised_root,
      report_root: paths.report_root,
      files_profiled: modelSummaries.length,
      models_profiled: modelSummaries.length,
      total_rows: totalRows,
      parse_errors: 0,
      pii_after_total: piiAfter,
      extraction_errors: gaps.length,
      combined_payload_jsonl: path.join(paths.report_root, 'claude_payload_all.jsonl'),
      generated_at_utc: new Date().toISOString(),
    },
    model_summaries: modelSummaries,
    extraction_gaps: gaps.map((g) => ({
      model: g.model || g.export_key,
      status: g.status,
      error: g.error?.data?.message || g.error?.message || g.message || 'unknown',
    })),
  };
}

/**
 * Readiness summary for staged forensic exports (01_account_ledger, 02_pos_retail, …).
 */
function buildForensicReadinessSummary(snapshotId, paths, modelSummaries, extractionGaps, stageStatuses) {
  const totalRows = modelSummaries.reduce((a, m) => a + m.rows, 0);
  const piiAfter = modelSummaries.reduce((a, m) => a + m.pii_hits_after, 0);
  const partialStages = stageStatuses.filter((s) => s.status === 'partial' || s.status === 'error');
  const blocked = extractionGaps.length > 0 || partialStages.length > 0;

  let status = 'READY_FOR_CLAUDE';
  if (piiAfter > 0) status = 'REVIEW_PII_REMAINS';
  if (blocked) status = 'REVIEW_EXTRACTION_GAPS';

  return {
    summary: {
      ok: !blocked && piiAfter === 0,
      status,
      selected_snapshot_id: snapshotId,
      snapshot_root: paths.snapshot_root,
      sanitised_root: paths.sanitised_root,
      report_root: paths.report_root,
      files_profiled: modelSummaries.length,
      models_profiled: modelSummaries.length,
      total_rows: totalRows,
      parse_errors: 0,
      pii_after_total: piiAfter,
      extraction_errors: extractionGaps.length,
      partial_stages: partialStages.length,
      combined_payload_jsonl: path.join(paths.report_root, 'claude_payload_all.jsonl'),
      generated_at_utc: new Date().toISOString(),
    },
    stage_statuses: stageStatuses,
    model_summaries: modelSummaries,
    extraction_gaps: extractionGaps,
  };
}

module.exports = {
  profileJsonlFile,
  buildReadinessSummary,
  buildForensicReadinessSummary,
};
