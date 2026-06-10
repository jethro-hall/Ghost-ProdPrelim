/**
 * PII-safe sanitisation for EOFY audit exports before Claude analysis.
 */

const crypto = require('crypto');

const PERSONAL_FIELD_PATTERNS = [
  /partner/i,
  /email/i,
  /phone/i,
  /login/i,
  /author/i,
  /commercial_partner/i,
  /acc_number/i,
  /payment_ref/i,
];

const BANK_FIELD_PATTERNS = [/acc_number/i, /bank_/i, /payment_ref/i];

const TEXT_COMPACT_FIELDS = ['name', 'ref', 'description', 'payment_ref', 'message'];

function hashEntity(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  const h = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  if (/^ENTITY_[a-f0-9]+$/i.test(raw)) return raw;
  return `ENTITY_${h}`;
}

function compactText(value, maxLen = 64) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'false') return raw;
  if (raw.length <= maxLen) return raw;
  const h = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${raw.slice(0, maxLen - 30)}... [TEXT_TRUNCATED hash=${h} len=${raw.length}]`;
}

function matchesAny(field, patterns) {
  return patterns.some((p) => p.test(field));
}

function sanitiseRecord(record, modelKey, policy, sourceFile) {
  const out = { ...record };
  let personal = 0;
  let bank = 0;
  let compacted = 0;

  for (const [field, value] of Object.entries(out)) {
    if (field === '_sanitisation' || field.endsWith('_id')) continue;

    if (policy.partner_names_hashed && matchesAny(field, PERSONAL_FIELD_PATTERNS)) {
      if (typeof value === 'string' && value && value !== 'false') {
        out[field] = hashEntity(value);
        personal += 1;
      }
    }

    if (policy.bank_details_redacted && matchesAny(field, BANK_FIELD_PATTERNS)) {
      if (typeof value === 'string' && value && value !== 'false') {
        out[field] = '[REDACTED_BANK]';
        bank += 1;
      }
    }

    if (policy.descriptions_compacted && TEXT_COMPACT_FIELDS.includes(field)) {
      if (typeof value === 'string' && value.length > policy.text_compact_max_len) {
        out[field] = compactText(value, policy.text_compact_max_len);
        compacted += 1;
      }
    }

    if (field.endsWith('_label') && policy.partner_names_hashed) {
      if (typeof value === 'string' && value && value !== 'false') {
        out[field] = hashEntity(value);
        personal += 1;
      }
    }
  }

  out._sanitisation = {
    model: modelKey,
    source_file: sourceFile,
    sanitised_at_utc: new Date().toISOString(),
    personal_fields_redacted: personal,
    bank_fields_redacted: bank,
    compacted_text_fields: compacted,
    policy: 'partner/user identities hashed; bank details redacted; descriptions compacted',
  };

  return out;
}

module.exports = {
  sanitiseRecord,
  hashEntity,
  compactText,
};
