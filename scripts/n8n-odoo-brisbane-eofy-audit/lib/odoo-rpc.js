/**
 * Odoo JSON-RPC helpers for n8n Code nodes (self-hosted).
 * Paste into Code nodes or import via generate_workflows.py embedding.
 */

function odooGetDbName(db, url) {
  if (db && String(db).trim()) return String(db).trim();
  try {
    const host = new URL(url).hostname;
    return host.split('.')[0] || 'odoo';
  } catch {
    return 'odoo';
  }
}

async function odooJsonRpc(callContext, url, body) {
  const response = await callContext.helpers.httpRequest({
    method: 'POST',
    url: `${String(url).replace(/\/$/, '')}/jsonrpc`,
    body,
    json: true,
    headers: { 'Content-Type': 'application/json' },
  });
  if (response.error) {
    const err = new Error(response.error.message || 'Odoo JSON-RPC error');
    err.odoo = response.error;
    throw err;
  }
  return response.result;
}

async function odooAuthenticate(callContext, credentials) {
  const url = credentials.url;
  const username = credentials.username;
  const password = credentials.password;
  const db = odooGetDbName(credentials.db, url);
  const uid = await odooJsonRpc(callContext, url, {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'common',
      method: 'authenticate',
      args: [db, username, password, {}],
    },
    id: Date.now(),
  });
  if (!uid) throw new Error('Odoo authentication failed — check credentials');
  return { db, uid, url, password };
}

async function odooExecuteKw(callContext, auth, model, method, args = [], kwargs = {}) {
  return odooJsonRpc(callContext, auth.url, {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [auth.db, auth.uid, auth.password, model, method, args, kwargs],
    },
    id: Date.now(),
  });
}

async function odooSearchCount(callContext, auth, model, domain) {
  return odooExecuteKw(callContext, auth, model, 'search_count', [domain]);
}

async function odooSearchRead(callContext, auth, model, domain, fields, offset, limit, order) {
  return odooExecuteKw(callContext, auth, model, 'search_read', [domain], {
    fields,
    offset,
    limit,
    order,
  });
}

function flattenMany2one(record) {
  const out = { ...record };
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
      out[`${key}_id`] = value[0];
      out[`${key}_label`] = value[1];
    }
  }
  return out;
}

function buildDomain(modelDef, scope) {
  const domain = [];
  const companyId = scope.company_id;
  const fyStart = scope.financial_year_start;
  const fyEnd = scope.financial_year_end;

  if (modelDef.domain_extra && modelDef.domain_extra.length) {
    for (const clause of modelDef.domain_extra) domain.push(clause);
  }

  if (modelDef.company_field) {
    if (modelDef.company_field === 'id') {
      domain.push(['id', '=', companyId]);
    } else if (!modelDef.company_field_optional) {
      domain.push([modelDef.company_field, '=', companyId]);
    } else {
      domain.push('|', [modelDef.company_field, '=', companyId], [modelDef.company_field, '=', false]);
    }
  }

  const dateField = modelDef.date_field || modelDef.date_field_fallback;
  if (dateField && fyStart && fyEnd) {
    domain.push([dateField, '>=', fyStart]);
    domain.push([dateField, '<=', fyEnd]);
  }

  return domain;
}

function exportFileBase(snapshotId, group, exportKey, offset) {
  const pad = String(offset).padStart(9, '0');
  return `${snapshotId}__${group}__${exportKey}__${pad}`;
}

module.exports = {
  odooGetDbName,
  odooJsonRpc,
  odooAuthenticate,
  odooExecuteKw,
  odooSearchCount,
  odooSearchRead,
  flattenMany2one,
  buildDomain,
  exportFileBase,
};
