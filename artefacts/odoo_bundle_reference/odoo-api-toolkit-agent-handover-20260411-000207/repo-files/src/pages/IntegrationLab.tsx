import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Activity,
  CheckCircle2,
  Clock3,
  Database,
  Loader2,
  Play,
  Save,
  Search,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';

type Tool = { id: string; name: string; kind: string; config: Record<string, unknown>; status: string };
type ModelRow = { id: string; label?: string | null; model_id?: string | null; provider_name?: string | null };
type TestResult = {
  ok: boolean;
  status?: number;
  latency_ms?: number;
  trace_id?: string;
  response_snippet?: string | null;
  error?: string;
  [key: string]: unknown;
};
type ExecuteResult = {
  ok?: boolean;
  trace_id?: string;
  latency_ms?: number;
  error?: string;
  data?: unknown;
  [key: string]: unknown;
};
type RequestLog = {
  trace_id: string;
  span_id: string;
  service: string;
  route: string;
  start_ts: string;
  end_ts: string;
  latency_ms: number;
  status: number;
  error: string | null;
  metadata: Record<string, unknown>;
};
type LabScenario = {
  id: string;
  tool_id: string;
  tool_kind: string;
  name: string;
  operation: string;
  payload: string;
  analysis_model_uuid?: string;
  created_at: string;
  updated_at?: string;
};
type LabScenarioEditor = {
  open: boolean;
  scenarioId: string | null;
  name: string;
  operation: string;
  payload: string;
  analysis_model_uuid: string;
};
type OdooPackRunStep = {
  title: string;
  operation: string;
  latency_ms?: number;
  ok: boolean;
  error?: string | null;
  trace_id?: string | null;
  preview?: string | null;
};
type OdooPackRun = {
  id: string;
  label: string;
  description: string;
  steps: OdooPackRunStep[];
  completed_at: string;
};

const INTEGRATION_SCENARIOS_STORAGE_KEY = 'ghostdash.integrationlab.scenarios.v1';
const INTEGRATION_DRAFTS_STORAGE_KEY = 'ghostdash.integrationlab.drafts.v1';

const TOOL_GROUPS = [
  { id: 'shopify_mcp', label: 'Shopify', description: 'Commerce and analytics' },
  { id: 'odoo_rpc', label: 'Odoo', description: 'ERP and financial reads' },
  { id: 'hubtiger', label: 'Hubtiger', description: 'Workshop and service operations' },
] as const;

const OPERATIONS_BY_KIND: Record<string, string[]> = {
  shopify_mcp: [
    'list_products',
    'shopify.products.search',
    'shopify.orders.search',
    'shopify.customers.search',
    'shopify.analytics.sales_summary',
    'top_products',
    'inventory_risk_report',
  ],
  odoo_rpc: [
    'odoo.current_user',
    'odoo.meta.current_user',
    'odoo.meta.version',
    'odoo.meta.companies.list',
    'odoo.products.search',
    'odoo.masters.products.search',
    'odoo.customers.search',
    'odoo.masters.customers.search',
    'odoo.sale_orders.search',
    'odoo.sales.orders.search',
    'odoo.invoices.search',
    'odoo.finance.invoices.search',
    'odoo.finance.receivables.open',
    'odoo.finance.payables.open',
    'odoo.finance.journal_entries.search',
    'odoo.finance.payments.search',
    'odoo.finance.accounts.search',
    'odoo.purchasing.orders.search',
    'odoo.inventory.quants.search',
    'odoo.inventory.valuation.search',
    'odoo.search_read',
    'odoo.execute_kw',
  ],
  hubtiger: [
    'jobs_search',
    'job_get',
    'job_messages',
    'customer_search',
    'bookings_week_samples',
    'booking_find_earliest',
    'booking_create',
    'quote_request_approval',
  ],
};

const PRESET_SCENARIOS: Record<string, Array<{ name: string; operation: string; payload: Record<string, unknown> }>> = {
  shopify_mcp: [
    { name: 'Active products', operation: 'list_products', payload: { limit: 3, status: 'ACTIVE' } },
    { name: 'Sales summary', operation: 'shopify.analytics.sales_summary', payload: { start_date: '2026-01-01', end_date: '2026-03-31', granularity: 'month' } },
    { name: 'Inventory risk', operation: 'inventory_risk_report', payload: { days_of_cover_threshold: 21, low_stock_threshold: 5 } },
  ],
  odoo_rpc: [
    { name: 'Current user', operation: 'odoo.meta.current_user', payload: {} },
    { name: 'Recent invoices', operation: 'odoo.finance.invoices.search', payload: { query: '', limit: 10 } },
    { name: 'Products sample', operation: 'odoo.masters.products.search', payload: { query: '', limit: 10 } },
    { name: 'Open receivables', operation: 'odoo.finance.receivables.open', payload: { limit: 20 } },
  ],
  hubtiger: [
    { name: 'Jobs search', operation: 'jobs_search', payload: { q: 'Jeff Hall', allStores: false } },
    { name: 'Customer search', operation: 'customer_search', payload: { q: '0435185134', type: 'phone', page: 0, limit: 20 } },
    { name: 'Week samples', operation: 'bookings_week_samples', payload: { count: 3, distinctStores: true } },
  ],
};

const ODOO_FINANCIAL_PACKS: Array<{
  id: string;
  label: string;
  description: string;
  steps: Array<{ title: string; operation: string; payload: Record<string, unknown> }>;
}> = [
  {
    id: 'receivables',
    label: 'Receivables Snapshot',
    description: 'Customer invoices, open receivables, and payment-state exposure.',
    steps: [
      {
        title: 'Recent customer invoices',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.move',
          domain: [['move_type', 'in', ['out_invoice', 'out_refund']]],
          fields: ['id', 'name', 'partner_id', 'invoice_date', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state', 'state'],
          limit: 20,
          order: 'invoice_date desc',
        },
      },
      {
        title: 'Open receivables',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.move',
          domain: [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['payment_state', 'in', ['not_paid', 'partial']]],
          fields: ['id', 'name', 'partner_id', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state'],
          limit: 20,
          order: 'invoice_date_due asc',
        },
      },
    ],
  },
  {
    id: 'payables',
    label: 'Payables Snapshot',
    description: 'Vendor bills and unpaid supplier exposure.',
    steps: [
      {
        title: 'Recent vendor bills',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.move',
          domain: [['move_type', 'in', ['in_invoice', 'in_refund']]],
          fields: ['id', 'name', 'partner_id', 'invoice_date', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state', 'state'],
          limit: 20,
          order: 'invoice_date desc',
        },
      },
      {
        title: 'Unpaid vendor bills',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.move',
          domain: [['move_type', '=', 'in_invoice'], ['state', '=', 'posted'], ['payment_state', 'in', ['not_paid', 'partial']]],
          fields: ['id', 'name', 'partner_id', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state'],
          limit: 20,
          order: 'invoice_date_due asc',
        },
      },
    ],
  },
  {
    id: 'journals',
    label: 'Journal Entry Audit',
    description: 'Recent journal entries plus ledger-line sampling for accounting depth.',
    steps: [
      {
        title: 'Recent journal entries',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.move',
          domain: [['move_type', '=', 'entry']],
          fields: ['id', 'name', 'date', 'journal_id', 'state', 'ref'],
          limit: 20,
          order: 'date desc',
        },
      },
      {
        title: 'Ledger lines sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.move.line',
          domain: [],
          fields: ['id', 'date', 'move_name', 'name', 'account_id', 'partner_id', 'debit', 'credit', 'balance', 'amount_currency'],
          limit: 25,
          order: 'date desc',
        },
      },
    ],
  },
  {
    id: 'sales-finance',
    label: 'Sales to Cash',
    description: 'Sale orders, invoice linkage signals, and customer activity.',
    steps: [
      {
        title: 'Recent sale orders',
        operation: 'odoo.sale_orders.search',
        payload: {
          query: '',
          limit: 20,
          fields: ['id', 'name', 'partner_id', 'date_order', 'amount_total', 'state', 'invoice_status'],
        },
      },
      {
        title: 'Recent customer records',
        operation: 'odoo.customers.search',
        payload: {
          query: '',
          limit: 20,
          fields: ['id', 'name', 'email', 'phone', 'customer_rank'],
        },
      },
    ],
  },
  {
    id: 'chart-of-accounts',
    label: 'Chart of Accounts',
    description: 'Account structure, account types, and reconcile flags.',
    steps: [
      {
        title: 'Accounts sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.account',
          domain: [],
          fields: ['id', 'code', 'name', 'account_type', 'reconcile', 'deprecated'],
          limit: 30,
          order: 'code asc',
        },
      },
      {
        title: 'Companies sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'res.company',
          domain: [],
          fields: ['id', 'name', 'currency_id'],
          limit: 10,
          order: 'name asc',
        },
      },
    ],
  },
  {
    id: 'journals-map',
    label: 'Journal Map',
    description: 'Journal configuration and journal entry relationships.',
    steps: [
      {
        title: 'Journals sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.journal',
          domain: [],
          fields: ['id', 'name', 'code', 'type', 'currency_id', 'company_id'],
          limit: 25,
          order: 'code asc',
        },
      },
      {
        title: 'Recent manual entries',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.move',
          domain: [['move_type', '=', 'entry']],
          fields: ['id', 'name', 'date', 'journal_id', 'state', 'ref'],
          limit: 25,
          order: 'date desc',
        },
      },
    ],
  },
  {
    id: 'payments-cash',
    label: 'Payments & Cash',
    description: 'Payment records and recent cash movement signals.',
    steps: [
      {
        title: 'Payments sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.payment',
          domain: [],
          fields: ['id', 'name', 'date', 'payment_type', 'partner_type', 'partner_id', 'amount', 'currency_id', 'state', 'journal_id'],
          limit: 25,
          order: 'date desc',
        },
      },
      {
        title: 'Payment journals sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.journal',
          domain: [['type', 'in', ['bank', 'cash']]],
          fields: ['id', 'name', 'code', 'type', 'currency_id'],
          limit: 20,
          order: 'code asc',
        },
      },
    ],
  },
  {
    id: 'purchase-commitments',
    label: 'Purchase Commitments',
    description: 'Vendor purchasing and open PO line commitments.',
    steps: [
      {
        title: 'Purchase orders sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'purchase.order',
          domain: [],
          fields: ['id', 'name', 'partner_id', 'date_order', 'currency_id', 'amount_total', 'state'],
          limit: 20,
          order: 'date_order desc',
        },
      },
      {
        title: 'Purchase order lines sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'purchase.order.line',
          domain: [],
          fields: ['id', 'name', 'product_id', 'product_qty', 'qty_received', 'price_unit', 'price_subtotal', 'date_planned', 'order_id'],
          limit: 25,
          order: 'id desc',
        },
      },
    ],
  },
  {
    id: 'inventory-position',
    label: 'Inventory Position',
    description: 'On-hand inventory, stock movement, and location sampling.',
    steps: [
      {
        title: 'Stock quants sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'stock.quant',
          domain: [],
          fields: ['id', 'product_id', 'location_id', 'quantity', 'available_quantity', 'company_id'],
          limit: 25,
          order: 'id desc',
        },
      },
      {
        title: 'Stock moves sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'stock.move',
          domain: [],
          fields: ['id', 'product_id', 'date', 'state', 'location_id', 'location_dest_id', 'product_uom_qty', 'quantity'],
          limit: 25,
          order: 'date desc',
        },
      },
    ],
  },
  {
    id: 'inventory-valuation',
    label: 'Inventory Valuation',
    description: 'Valuation layers and costing movement visibility.',
    steps: [
      {
        title: 'Valuation layers sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'stock.valuation.layer',
          domain: [],
          fields: ['id', 'product_id', 'quantity', 'value', 'remaining_qty', 'remaining_value', 'create_date', 'company_id'],
          limit: 25,
          order: 'create_date desc',
        },
      },
      {
        title: 'Products valuation sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'product.template',
          domain: [],
          fields: ['id', 'name', 'categ_id', 'list_price', 'standard_price', 'qty_available', 'uom_id'],
          limit: 25,
          order: 'name asc',
        },
      },
    ],
  },
  {
    id: 'tax-map',
    label: 'Tax Map',
    description: 'Tax setup and invoice tax relationships.',
    steps: [
      {
        title: 'Taxes sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.tax',
          domain: [],
          fields: ['id', 'name', 'amount', 'amount_type', 'type_tax_use', 'active'],
          limit: 25,
          order: 'name asc',
        },
      },
      {
        title: 'Customer invoices sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.move',
          domain: [['move_type', '=', 'out_invoice']],
          fields: ['id', 'name', 'invoice_date', 'partner_id', 'amount_total', 'state'],
          limit: 20,
          order: 'invoice_date desc',
        },
      },
    ],
  },
  {
    id: 'customer-ledger',
    label: 'Customer Ledger View',
    description: 'Customer exposure, partner segmentation, and open customer activity.',
    steps: [
      {
        title: 'Customer partners sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'res.partner',
          domain: [['customer_rank', '>', 0]],
          fields: ['id', 'name', 'email', 'phone', 'customer_rank', 'property_payment_term_id'],
          limit: 25,
          order: 'name asc',
        },
      },
      {
        title: 'Open customer invoices',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.move',
          domain: [['move_type', '=', 'out_invoice'], ['payment_state', 'in', ['not_paid', 'partial']]],
          fields: ['id', 'name', 'partner_id', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state'],
          limit: 25,
          order: 'invoice_date_due asc',
        },
      },
    ],
  },
  {
    id: 'vendor-ledger',
    label: 'Vendor Ledger View',
    description: 'Vendor exposure and unpaid supplier activity.',
    steps: [
      {
        title: 'Vendor partners sample',
        operation: 'odoo.search_read',
        payload: {
          model: 'res.partner',
          domain: [['supplier_rank', '>', 0]],
          fields: ['id', 'name', 'email', 'phone', 'supplier_rank', 'property_supplier_payment_term_id'],
          limit: 25,
          order: 'name asc',
        },
      },
      {
        title: 'Open vendor bills',
        operation: 'odoo.search_read',
        payload: {
          model: 'account.move',
          domain: [['move_type', '=', 'in_invoice'], ['payment_state', 'in', ['not_paid', 'partial']]],
          fields: ['id', 'name', 'partner_id', 'invoice_date_due', 'amount_total', 'amount_residual', 'payment_state'],
          limit: 25,
          order: 'invoice_date_due asc',
        },
      },
    ],
  },
];

async function fetchTools(): Promise<Tool[]> {
  const res = await fetch('/api/tools', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to load tools');
  return res.json();
}

async function fetchModels(): Promise<ModelRow[]> {
  const res = await fetch('/api/models', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to load models');
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function testTool(toolId: string, query = ''): Promise<TestResult> {
  const res = await fetch(`/api/tools/${toolId}/test`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: (data as any)?.error || res.statusText, ...data };
  return data as TestResult;
}

async function executeTool(toolId: string, operation: string, payload: unknown): Promise<ExecuteResult> {
  const res = await fetch(`/api/tools/${toolId}/execute`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: (data as any)?.error || res.statusText, ...data };
  return data as ExecuteResult;
}

async function fetchTraceLogs(traceId: string): Promise<RequestLog[]> {
  if (!traceId.trim()) return [];
  const res = await fetch(`/api/logs?trace_id=${encodeURIComponent(traceId)}&limit=200`, { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to load trace logs');
  const data = await res.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

function parseJsonSafe(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new Error('Payload must be valid JSON');
  }
}

function defaultPayloadForOperation(operation: string): string {
  const kind = operation.startsWith('odoo.')
    ? 'odoo_rpc'
    : operation.startsWith('shopify.') || ['list_products', 'top_products', 'inventory_risk_report'].includes(operation)
      ? 'shopify_mcp'
      : 'hubtiger';
  const preset = (PRESET_SCENARIOS[kind] || []).find((item) => item.operation === operation);
  return JSON.stringify(preset?.payload || {}, null, 2);
}

function displayModelLabel(models: ModelRow[], modelUuid: string) {
  const model = models.find((row) => row.id === modelUuid);
  if (!model) return 'Auto';
  return String(model.label || model.model_id || model.id).trim() || modelUuid;
}

function compactPreview(data: unknown, maxChars = 700) {
  try {
    const text = JSON.stringify(data, null, 2);
    return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
  } catch {
    return String(data);
  }
}

function loadScenarios(): LabScenario[] {
  try {
    const raw = localStorage.getItem(INTEGRATION_SCENARIOS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadDrafts(): {
  selectedKind: string;
  selectedToolId: string;
  selectedOperation: string;
  payloadText: string;
  analysisModelUuid: string;
} {
  try {
    const raw = localStorage.getItem(INTEGRATION_DRAFTS_STORAGE_KEY);
    if (!raw) {
      return {
        selectedKind: 'shopify_mcp',
        selectedToolId: '',
        selectedOperation: 'list_products',
        payloadText: defaultPayloadForOperation('list_products'),
        analysisModelUuid: '',
      };
    }
    const parsed = JSON.parse(raw);
    return {
      selectedKind: String(parsed?.selectedKind || 'shopify_mcp'),
      selectedToolId: String(parsed?.selectedToolId || ''),
      selectedOperation: String(parsed?.selectedOperation || 'list_products'),
      payloadText: String(parsed?.payloadText || defaultPayloadForOperation(String(parsed?.selectedOperation || 'list_products'))),
      analysisModelUuid: String(parsed?.analysisModelUuid || ''),
    };
  } catch {
    return {
      selectedKind: 'shopify_mcp',
      selectedToolId: '',
      selectedOperation: 'list_products',
      payloadText: defaultPayloadForOperation('list_products'),
      analysisModelUuid: '',
    };
  }
}

export function IntegrationLab() {
  const initialDrafts = loadDrafts();
  const [tools, setTools] = useState<Tool[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedKind, setSelectedKind] = useState<string>(initialDrafts.selectedKind);
  const [selectedToolId, setSelectedToolId] = useState<string>(initialDrafts.selectedToolId);
  const [selectedOperation, setSelectedOperation] = useState<string>(initialDrafts.selectedOperation);
  const [payloadText, setPayloadText] = useState<string>(initialDrafts.payloadText);
  const [analysisModelUuid, setAnalysisModelUuid] = useState<string>(initialDrafts.analysisModelUuid);

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [executeResult, setExecuteResult] = useState<ExecuteResult | null>(null);
  const [traceLogs, setTraceLogs] = useState<RequestLog[]>([]);
  const [traceLogsLoading, setTraceLogsLoading] = useState(false);
  const [traceLogsError, setTraceLogsError] = useState<string | null>(null);
  const [runningAction, setRunningAction] = useState<'test' | 'execute' | 'analysis' | null>(null);
  const [analysisText, setAnalysisText] = useState<string>('');
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [savedScenarios, setSavedScenarios] = useState<LabScenario[]>([]);
  const [scenarioEditor, setScenarioEditor] = useState<LabScenarioEditor>({
    open: false,
    scenarioId: null,
    name: '',
    operation: '',
    payload: '{}',
    analysis_model_uuid: '',
  });
  const [message, setMessage] = useState<string>('');
  const [odooPackRun, setOdooPackRun] = useState<OdooPackRun | null>(null);

  useEffect(() => {
    Promise.all([fetchTools(), fetchModels()])
      .then(([toolRows, modelRows]) => {
        setTools(toolRows);
        setModels(modelRows);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load integration lab'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setSavedScenarios(loadScenarios());
  }, []);

  const filteredTools = useMemo(
    () => tools.filter((tool) => tool.kind === selectedKind),
    [tools, selectedKind]
  );

  const selectedTool = useMemo(
    () => filteredTools.find((tool) => tool.id === selectedToolId) || filteredTools[0] || null,
    [filteredTools, selectedToolId]
  );

  useEffect(() => {
    if (!selectedTool && filteredTools[0]) {
      setSelectedToolId(filteredTools[0].id);
      return;
    }
    if (selectedTool && selectedTool.id !== selectedToolId) {
      setSelectedToolId(selectedTool.id);
    }
  }, [filteredTools, selectedTool, selectedToolId]);

  useEffect(() => {
    localStorage.setItem(
      INTEGRATION_DRAFTS_STORAGE_KEY,
      JSON.stringify({
        selectedKind,
        selectedToolId: selectedTool?.id || selectedToolId,
        selectedOperation,
        payloadText,
        analysisModelUuid,
      })
    );
  }, [selectedKind, selectedToolId, selectedTool, selectedOperation, payloadText, analysisModelUuid]);

  useEffect(() => {
    localStorage.setItem(INTEGRATION_SCENARIOS_STORAGE_KEY, JSON.stringify(savedScenarios));
  }, [savedScenarios]);

  useEffect(() => {
    const allowed = OPERATIONS_BY_KIND[selectedKind] || [];
    if (!allowed.includes(selectedOperation)) {
      const next = allowed[0] || '';
      setSelectedOperation(next);
      setPayloadText(defaultPayloadForOperation(next));
    }
  }, [selectedKind, selectedOperation]);

  const scenariosForTool = useMemo(
    () => savedScenarios.filter((scenario) => selectedTool && scenario.tool_id === selectedTool.id),
    [savedScenarios, selectedTool]
  );

  const lastTraceId = String(
    executeResult?.trace_id
    || testResult?.trace_id
    || ''
  ).trim();

  const rawRequestPreview = useMemo(() => ({
    tool_id: selectedTool?.id || null,
    tool_kind: selectedTool?.kind || null,
    operation: selectedOperation,
    payload: (() => {
      try {
        return parseJsonSafe(payloadText);
      } catch {
        return payloadText;
      }
    })(),
  }), [selectedTool, selectedOperation, payloadText]);

  const openScenarioEditor = (scenario?: LabScenario | null) => {
    setScenarioEditor({
      open: true,
      scenarioId: scenario?.id || null,
      name: scenario?.name || '',
      operation: scenario?.operation || selectedOperation,
      payload: scenario?.payload || payloadText,
      analysis_model_uuid: scenario?.analysis_model_uuid || analysisModelUuid,
    });
  };

  const saveScenario = () => {
    if (!selectedTool) return;
    const name = scenarioEditor.name.trim();
    if (!name) return;
    const timestamp = new Date().toISOString();
    const nextScenario: LabScenario = {
      id: scenarioEditor.scenarioId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tool_id: selectedTool.id,
      tool_kind: selectedTool.kind,
      name,
      operation: scenarioEditor.operation,
      payload: scenarioEditor.payload,
      analysis_model_uuid: scenarioEditor.analysis_model_uuid,
      created_at: scenarioEditor.scenarioId
        ? (savedScenarios.find((item) => item.id === scenarioEditor.scenarioId)?.created_at || timestamp)
        : timestamp,
      updated_at: timestamp,
    };
    setSavedScenarios((prev) => {
      const rest = prev.filter((item) => item.id !== nextScenario.id);
      return [nextScenario, ...rest].slice(0, 80);
    });
    setSelectedOperation(nextScenario.operation);
    setPayloadText(nextScenario.payload);
    setAnalysisModelUuid(nextScenario.analysis_model_uuid || '');
    setScenarioEditor((prev) => ({ ...prev, open: false }));
    setMessage(`Scenario "${name}" saved locally for this integration.`);
  };

  const runTest = async () => {
    if (!selectedTool) return;
    setRunningAction('test');
    setMessage('');
    setTestResult(null);
    setTraceLogs([]);
    setTraceLogsError(null);
    setAnalysisText('');
    setAnalysisError(null);
    try {
      const query = selectedTool.kind === 'hubtiger'
        ? String((parseJsonSafe(payloadText) as any)?.q || (parseJsonSafe(payloadText) as any)?.query || '')
        : '';
      const result = await testTool(selectedTool.id, query);
      setTestResult(result);
      if (result.trace_id) {
        setTraceLogsLoading(true);
        try {
          setTraceLogs(await fetchTraceLogs(String(result.trace_id)));
        } catch (e) {
          setTraceLogsError(e instanceof Error ? e.message : 'Failed to load trace logs');
        } finally {
          setTraceLogsLoading(false);
        }
      }
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setRunningAction(null);
    }
  };

  const runExecute = async () => {
    if (!selectedTool) return;
    setRunningAction('execute');
    setMessage('');
    setExecuteResult(null);
    setTraceLogs([]);
    setTraceLogsError(null);
    setAnalysisText('');
    setAnalysisError(null);
    try {
      const payload = parseJsonSafe(payloadText);
      const result = await executeTool(selectedTool.id, selectedOperation, payload);
      setExecuteResult(result);
      if (result.trace_id) {
        setTraceLogsLoading(true);
        try {
          setTraceLogs(await fetchTraceLogs(String(result.trace_id)));
        } catch (e) {
          setTraceLogsError(e instanceof Error ? e.message : 'Failed to load trace logs');
        } finally {
          setTraceLogsLoading(false);
        }
      }
    } catch (e) {
      setExecuteResult({ ok: false, error: e instanceof Error ? e.message : 'Execute failed' });
    } finally {
      setRunningAction(null);
    }
  };

  const runAnalysis = async () => {
    if (!selectedTool) return;
    const current = executeResult || testResult;
    if (!current) {
      setAnalysisError('Run Test or Execute first so there is live data to analyze.');
      return;
    }
    setRunningAction('analysis');
    setAnalysisText('');
    setAnalysisError(null);
    try {
      const res = await fetch('/api/dashboard/llm/respond', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_uuid: analysisModelUuid || undefined,
          prompt: [
            'You are reviewing an integration test run inside GhostDash.',
            'Assess whether the integration is working, identify payload or validation issues, and suggest the next best query.',
            '',
            `Tool kind: ${selectedTool.kind}`,
            `Tool name: ${selectedTool.name}`,
            `Operation: ${selectedOperation}`,
            `Payload: ${payloadText}`,
            `Result: ${JSON.stringify(current, null, 2)}`,
            `Trace logs: ${JSON.stringify(traceLogs.slice(0, 20), null, 2)}`,
          ].join('\n'),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as any)?.error || 'Analysis failed');
      setAnalysisText(String((body as any)?.text || (body as any)?.response || JSON.stringify(body, null, 2)));
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setRunningAction(null);
    }
  };

  const currentResult = executeResult || testResult;

  const runOdooFinancialPack = async (packId: string) => {
    if (!selectedTool || selectedTool.kind !== 'odoo_rpc') return;
    const pack = ODOO_FINANCIAL_PACKS.find((item) => item.id === packId);
    if (!pack) return;
    setRunningAction('execute');
    setMessage('');
    setOdooPackRun(null);
    setTraceLogs([]);
    setTraceLogsError(null);
    setAnalysisText('');
    setAnalysisError(null);
    const steps: OdooPackRunStep[] = [];
    let lastTraceId = '';
    try {
      for (const step of pack.steps) {
        const result = await executeTool(selectedTool.id, step.operation, step.payload);
        const traceId = String(result.trace_id || '').trim();
        lastTraceId = traceId || lastTraceId;
        steps.push({
          title: step.title,
          operation: step.operation,
          latency_ms: Number(result.latency_ms || 0) || undefined,
          ok: result.ok === true,
          error: result.ok === true ? null : String(result.error || 'failed'),
          trace_id: traceId || null,
          preview: compactPreview(result.data ?? result),
        });
        if (result.ok !== true) break;
      }
      if (lastTraceId) {
        setTraceLogsLoading(true);
        try {
          setTraceLogs(await fetchTraceLogs(lastTraceId));
        } catch (e) {
          setTraceLogsError(e instanceof Error ? e.message : 'Failed to load trace logs');
        } finally {
          setTraceLogsLoading(false);
        }
      }
      setOdooPackRun({
        id: pack.id,
        label: pack.label,
        description: pack.description,
        steps,
        completed_at: new Date().toISOString(),
      });
      setMessage(`${pack.label} completed with ${steps.filter((step) => step.ok).length}/${steps.length} successful step(s).`);
    } finally {
      setRunningAction(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-7xl mx-auto space-y-6"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="page-title-accent text-3xl font-semibold tracking-tight">Integration Lab</h1>
          <p className="text-white/50 mt-1 text-sm">
            Dedicated operator lane for raw request building, scenario packs, trace drilldown, and tool response inspection.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {TOOL_GROUPS.map((group) => {
            const selected = selectedKind === group.id;
            return (
              <button
                key={group.id}
                type="button"
                onClick={() => setSelectedKind(group.id)}
                className={`glass-button px-3 py-2 rounded-xl text-sm ${selected ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100' : ''}`}
              >
                {group.label}
              </button>
            );
          })}
        </div>
      </div>

      {message ? (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
          {message}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-[1.05fr_0.95fr] gap-6">
        <section className="glass-panel rounded-3xl p-6 space-y-4">
          <div className="flex items-center gap-2 text-white/80">
            <Wrench size={16} />
            <h2 className="text-lg font-semibold">Request Builder</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-2">
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">Gateway</div>
              <select
                value={selectedTool?.id || ''}
                onChange={(e) => setSelectedToolId(e.target.value)}
                className="glass-input w-full px-3 py-2 rounded-lg text-sm bg-transparent"
              >
                {filteredTools.map((tool) => (
                  <option key={tool.id} value={tool.id} className="bg-slate-900">
                    {tool.name} · {tool.kind}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2">
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">Analysis Model</div>
              <select
                value={analysisModelUuid}
                onChange={(e) => setAnalysisModelUuid(e.target.value)}
                className="glass-input w-full px-3 py-2 rounded-lg text-sm bg-transparent"
              >
                <option value="">Auto (analysis only)</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id} className="bg-slate-900">
                    {displayModelLabel(models, model.id)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
            <label className="space-y-2">
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">Operation</div>
              <select
                value={selectedOperation}
                onChange={(e) => {
                  setSelectedOperation(e.target.value);
                  setPayloadText(defaultPayloadForOperation(e.target.value));
                }}
                className="glass-input w-full px-3 py-2 rounded-lg text-sm bg-transparent"
              >
                {(OPERATIONS_BY_KIND[selectedKind] || []).map((op) => (
                  <option key={op} value={op} className="bg-slate-900">
                    {op}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">Scenarios</div>
              <div className="flex gap-2">
                <button className="glass-button px-3 py-2 rounded-lg text-sm inline-flex items-center gap-2" onClick={() => openScenarioEditor(null)}>
                  <Save size={14} />
                  Save
                </button>
                <button className="glass-button px-3 py-2 rounded-lg text-sm inline-flex items-center gap-2" onClick={() => setMessage('Drafts auto-save locally while you type.')}>
                  <Clock3 size={14} />
                  Drafts
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">Payload JSON</div>
            <textarea
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              className="glass-input w-full min-h-64 rounded-xl px-3 py-3 text-xs font-mono"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            {(PRESET_SCENARIOS[selectedKind] || []).map((preset) => (
              <button
                key={preset.name}
                type="button"
                className="glass-button px-3 py-1.5 rounded-lg text-[11px]"
                onClick={() => {
                  setSelectedOperation(preset.operation);
                  setPayloadText(JSON.stringify(preset.payload, null, 2));
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>

          {selectedKind === 'odoo_rpc' ? (
            <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-4 space-y-3">
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-100">Odoo Financial Packs</div>
                <div className="mt-1 text-sm text-emerald-50/85">
                  One-click finance exploration packs for receivables, payables, journals, ledger lines, and sales-to-cash.
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {ODOO_FINANCIAL_PACKS.map((pack) => (
                  <div key={pack.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="text-sm font-semibold text-white/90">{pack.label}</div>
                    <div className="mt-1 text-xs text-white/55">{pack.description}</div>
                    <div className="mt-2 text-[11px] text-white/45">{pack.steps.length} step(s)</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        className="glass-button px-3 py-1.5 rounded-lg text-[11px]"
                        onClick={() => {
                          setSelectedOperation(pack.steps[0].operation);
                          setPayloadText(JSON.stringify(pack.steps[0].payload, null, 2));
                        }}
                      >
                        Load Step 1
                      </button>
                      <button
                        className="glass-button-primary px-3 py-1.5 rounded-lg text-[11px] inline-flex items-center gap-1.5"
                        disabled={runningAction !== null}
                        onClick={() => void runOdooFinancialPack(pack.id)}
                      >
                        {runningAction === 'execute' ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
                        Run Pack
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <button
              className="glass-button-primary px-4 py-2 rounded-xl inline-flex items-center gap-2"
              onClick={() => void runTest()}
              disabled={runningAction !== null}
            >
              {runningAction === 'test' ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              Test
            </button>
            <button
              className="glass-button-primary px-4 py-2 rounded-xl inline-flex items-center gap-2"
              onClick={() => void runExecute()}
              disabled={runningAction !== null}
            >
              {runningAction === 'execute' ? <Loader2 size={16} className="animate-spin" /> : <Activity size={16} />}
              Execute
            </button>
            <button
              className="glass-button px-4 py-2 rounded-xl inline-flex items-center gap-2"
              onClick={() => void runAnalysis()}
              disabled={runningAction !== null}
            >
              {runningAction === 'analysis' ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              Analyze with Model
            </button>
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 space-y-2">
            <div className="text-[11px] uppercase tracking-[0.18em] text-white/45">Saved Scenarios</div>
            {scenariosForTool.length === 0 ? (
              <div className="text-sm text-white/45">No saved scenarios for this gateway yet.</div>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {scenariosForTool.map((scenario) => (
                  <div key={scenario.id} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/75 flex flex-wrap items-center gap-2">
                    <span className="font-medium text-white/90">{scenario.name}</span>
                    <span className="text-white/45">{scenario.operation}</span>
                    {scenario.analysis_model_uuid ? <span className="text-white/35">· {displayModelLabel(models, scenario.analysis_model_uuid)}</span> : null}
                    <button className="glass-button px-2 py-0.5 rounded text-[10px]" onClick={() => {
                      setSelectedOperation(scenario.operation);
                      setPayloadText(scenario.payload);
                      setAnalysisModelUuid(scenario.analysis_model_uuid || '');
                    }}>
                      Load
                    </button>
                    <button className="glass-button px-2 py-0.5 rounded text-[10px]" onClick={() => openScenarioEditor(scenario)}>
                      Edit
                    </button>
                    <button className="glass-button px-2 py-0.5 rounded text-[10px]" onClick={() => setSavedScenarios((prev) => prev.filter((row) => row.id !== scenario.id))}>
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="glass-panel rounded-3xl p-6 space-y-4">
          <div className="flex items-center gap-2 text-white/80">
            <Database size={16} />
            <h2 className="text-lg font-semibold">Result & Trace</h2>
          </div>

          <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm font-mono space-y-1">
            <div className={currentResult?.ok ? 'text-emerald-400' : currentResult ? 'text-red-400' : 'text-white/50'}>
              {currentResult ? (currentResult.ok ? 'OK' : 'FAILED') : 'Awaiting request'} {currentResult?.latency_ms != null ? `· ${currentResult.latency_ms}ms` : ''}
            </div>
            {lastTraceId ? <div className="text-white/50 text-xs break-all">trace_id: {lastTraceId}</div> : null}
            <div className="text-white/50 text-xs">analysis model: {displayModelLabel(models, analysisModelUuid)}</div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/45 mb-2">Raw Request</div>
              <pre className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-white/75 max-h-52 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(rawRequestPreview, null, 2)}
              </pre>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/45 mb-2">Raw Response</div>
              <pre className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-white/75 max-h-72 overflow-auto whitespace-pre-wrap">
                {JSON.stringify(currentResult || {}, null, 2)}
              </pre>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/45 mb-2">Analysis Output</div>
              <pre className="rounded-xl border border-cyan-500/20 bg-black/20 p-3 text-xs text-cyan-100/85 max-h-52 overflow-auto whitespace-pre-wrap">
                {analysisError || analysisText || 'Run “Analyze with Model” after a test or execute run.'}
              </pre>
            </div>
            {odooPackRun ? (
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-white/45 mb-2">Odoo Financial Pack Result</div>
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {odooPackRun.steps.map((step, index) => (
                    <div key={`${odooPackRun.id}-${index}`} className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm text-white/90">{step.title}</div>
                        <div className={step.ok ? 'text-emerald-300 text-[11px]' : 'text-red-300 text-[11px]'}>
                          {step.ok ? 'OK' : 'FAILED'}{step.latency_ms != null ? ` · ${step.latency_ms}ms` : ''}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-white/45">{step.operation}</div>
                      {step.trace_id ? <div className="mt-1 text-[11px] text-white/45 break-all">trace_id: {step.trace_id}</div> : null}
                      {step.error ? <div className="mt-2 text-xs text-red-300">{step.error}</div> : null}
                      {step.preview ? (
                        <pre className="mt-2 text-[11px] text-white/65 whitespace-pre-wrap overflow-auto max-h-32">
                          {step.preview}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-white/45 mb-2">Trace Logs</div>
              {traceLogsLoading ? (
                <div className="inline-flex items-center gap-2 text-sm text-white/60">
                  <Loader2 size={14} className="animate-spin" />
                  Loading trace logs...
                </div>
              ) : traceLogsError ? (
                <div className="text-sm text-red-300">{traceLogsError}</div>
              ) : traceLogs.length === 0 ? (
                <div className="text-sm text-white/45">No trace logs loaded yet.</div>
              ) : (
                <div className="space-y-2 max-h-[32rem] overflow-y-auto pr-1">
                  {traceLogs.map((log) => (
                    <div key={`${log.trace_id}-${log.span_id}`} className="rounded-xl border border-white/10 bg-black/20 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm text-white/90">{log.route}</div>
                        <div className="text-[11px] text-white/50">{log.status} · {log.latency_ms}ms</div>
                      </div>
                      <div className="mt-1 text-[11px] text-white/45">{log.service} · {new Date(log.start_ts).toLocaleString()}</div>
                      {log.error ? <div className="mt-2 text-xs text-red-300">{log.error}</div> : null}
                      <pre className="mt-2 text-[11px] text-white/65 whitespace-pre-wrap overflow-auto max-h-32">
                        {JSON.stringify(log.metadata || {}, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {scenarioEditor.open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-panel w-full max-w-2xl rounded-2xl p-5 border border-white/10 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-white/90">{scenarioEditor.scenarioId ? 'Edit Scenario' : 'Save Scenario'}</div>
                <div className="text-xs text-white/50">Stored locally without page refresh.</div>
              </div>
              <button className="glass-button px-2 py-1 rounded-lg" onClick={() => setScenarioEditor((prev) => ({ ...prev, open: false }))}>
                <X size={14} />
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                className="glass-input px-3 py-2 rounded-lg text-sm"
                placeholder="Scenario name"
                value={scenarioEditor.name}
                onChange={(e) => setScenarioEditor((prev) => ({ ...prev, name: e.target.value }))}
              />
              <select
                className="glass-input px-3 py-2 rounded-lg text-sm bg-transparent"
                value={scenarioEditor.analysis_model_uuid}
                onChange={(e) => setScenarioEditor((prev) => ({ ...prev, analysis_model_uuid: e.target.value }))}
              >
                <option value="">Auto (analysis only)</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id} className="bg-slate-900">
                    {displayModelLabel(models, model.id)}
                  </option>
                ))}
              </select>
            </div>
            <input
              className="glass-input w-full px-3 py-2 rounded-lg text-sm"
              placeholder="Operation"
              value={scenarioEditor.operation}
              onChange={(e) => setScenarioEditor((prev) => ({ ...prev, operation: e.target.value }))}
            />
            <textarea
              className="glass-input w-full px-3 py-2 rounded-lg text-xs font-mono min-h-44"
              value={scenarioEditor.payload}
              onChange={(e) => setScenarioEditor((prev) => ({ ...prev, payload: e.target.value }))}
            />
            <div className="flex justify-end gap-2">
              <button className="glass-button px-3 py-2 rounded-lg text-sm" onClick={() => setScenarioEditor((prev) => ({ ...prev, open: false }))}>
                Cancel
              </button>
              <button className="glass-button-primary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-2" onClick={saveScenario}>
                <Save size={14} />
                Save Scenario
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="glass-panel rounded-2xl p-8 flex items-center justify-center gap-2 text-white/60">
          <Loader2 size={20} className="animate-spin" />
          Loading Integration Lab…
        </div>
      ) : null}
    </motion.div>
  );
}
