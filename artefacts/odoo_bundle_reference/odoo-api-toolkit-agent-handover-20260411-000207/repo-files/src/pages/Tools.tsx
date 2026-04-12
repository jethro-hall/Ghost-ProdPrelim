import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Wrench, Plus, Key, Link as LinkIcon, CheckCircle2, Loader2, Play, Store, BriefcaseBusiness, Layers3, Building2, Save, Pencil, Sparkles, X } from 'lucide-react';

type Tool = { id: string; name: string; kind: string; config: Record<string, unknown>; status: string };
type ModelRow = { id: string; label?: string | null; model_id?: string | null; provider_name?: string | null };
type TestResult = {
  ok: boolean;
  status?: number;
  latency_ms?: number;
  trace_id?: string;
  response_snippet?: string | null;
  error?: string;
  retry_count?: number;
  cache_hit?: boolean;
  circuit_state?: string | null;
};
type ExecuteResult = { ok?: boolean; trace_id?: string; latency_ms?: number; error?: string; [key: string]: unknown };
type ShopifyDiagnosticResult = {
  ok: boolean;
  steps: Array<{ operation: string; ok: boolean; latency_ms?: number; error?: string }>;
  summary: string;
};
type SavedScenario = {
  id: string;
  tool_id: string;
  tool_kind: string;
  name: string;
  operation: string;
  payload: string;
  model_uuid?: string;
  created_at: string;
  updated_at?: string;
};
type ScenarioEditorState = {
  open: boolean;
  toolId: string;
  scenarioId: string | null;
  name: string;
  operation: string;
  payload: string;
  model_uuid: string;
};
type ShopifyConnectionDraft = {
  base_url: string;
  test_path: string;
  execute_path: string;
  internal_key: string;
  api_token: string;
};
type BookingSample = {
  serviceID: number;
  jobCardNo: string;
  customerID: number;
  customerName: string;
  bike?: string | null;
  dateCheckedIn?: string | null;
  technicianID?: number | null;
  technicianName?: string;
  storeName?: string;
  duration?: number;
};

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

async function testTool(toolId: string, query?: string, authOverride?: { internal_key?: string; api_token?: string }): Promise<TestResult> {
  const res = await fetch(`/api/tools/${toolId}/test`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query ?? '', auth_override: authOverride || {} }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.error || res.statusText, ...data };
  return data;
}

async function executeTool(toolId: string, operation: string, payload: unknown, authOverride?: { internal_key?: string; api_token?: string }): Promise<ExecuteResult> {
  const res = await fetch(`/api/tools/${toolId}/execute`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, payload, auth_override: authOverride || {} }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: (data as any)?.error || res.statusText, ...data };
  return data;
}

const HUB_OPS = [
  'jobs_search',
  'job_get',
  'job_messages',
  'messages_unread',
  'customer_search',
  'bookings_week_samples',
  'products_search',
  'booking_find_earliest',
  'availability_search',
  'booking_create',
  'booking_amend_slot',
  'booking_amend',
  'job_note_add',
  'quote_add_line_item',
  'quote_find_add',
  'quote_find_add_and_request_approval',
  'quote_request_approval',
  'portal_call',
] as const;
const SHOPIFY_OPS = [
  'shopify.products.search',
  'shopify.orders.search',
  'shopify.customers.search',
  'shopify.inventory.levels',
  'shopify.analytics.sales_summary',
  'sales_summary',
  'top_products',
  'inventory_risk_report',
  'product_vendor_performance',
  'discount_performance',
  'list_products',
] as const;
const ODOO_OPS = [
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
] as const;
const TOOL_SCENARIOS_STORAGE_KEY = 'ghostdash.toolgateway.saved_scenarios.v2';
const LEGACY_SHOPIFY_SCENARIOS_STORAGE_KEY = 'ghostdash.shopify.saved_scenarios.v1';
const TOOL_DRAFTS_STORAGE_KEY = 'ghostdash.toolgateway.drafts.v2';

function inferToolKindFromScenario(input: { tool_kind?: string; operation?: string }, fallback = ''): string {
  const explicit = String(input.tool_kind || '').trim();
  if (explicit) return explicit;
  const operation = String(input.operation || '').trim().toLowerCase();
  if (operation.startsWith('shopify.') || operation === 'sales_summary' || operation === 'top_products' || operation === 'inventory_risk_report' || operation === 'product_vendor_performance' || operation === 'discount_performance' || operation === 'list_products') {
    return 'shopify_mcp';
  }
  if (operation.startsWith('odoo.')) return 'odoo_rpc';
  if (operation) return 'hubtiger';
  return fallback;
}

function loadSavedScenarios(): SavedScenario[] {
  try {
    const parseList = (raw: string | null): unknown[] => {
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    };
    const v2 = parseList(localStorage.getItem(TOOL_SCENARIOS_STORAGE_KEY));
    const legacy = parseList(localStorage.getItem(LEGACY_SHOPIFY_SCENARIOS_STORAGE_KEY));
    const merged = [...v2, ...legacy];
    const normalized = merged
      .filter((s) => s && typeof s === 'object')
      .map((s) => {
        const row = s as Record<string, unknown>;
        const operation = String(row.operation || '');
        return {
          id: String(row.id || ''),
          tool_id: String(row.tool_id || ''),
          tool_kind: inferToolKindFromScenario(
            {
              tool_kind: String(row.tool_kind || ''),
              operation,
            },
            // Legacy v1 scenarios were Shopify-only by design.
            'shopify_mcp'
          ),
          name: String(row.name || ''),
          operation,
          payload: String(row.payload || '{}'),
          model_uuid: String(row.model_uuid || ''),
          created_at: String(row.created_at || new Date().toISOString()),
          updated_at: String(row.updated_at || ''),
        };
      })
      .filter((s) => s.id && s.name && s.operation && s.tool_kind);
    // Keep only the latest record per scenario id to prevent
    // duplicate rendering when both legacy and v2 entries exist.
    const deduped = new Map<string, SavedScenario>();
    for (const row of normalized) {
      const existing = deduped.get(row.id);
      if (!existing) {
        deduped.set(row.id, row);
        continue;
      }
      const existingUpdated = Date.parse(String(existing.updated_at || existing.created_at || 0));
      const rowUpdated = Date.parse(String(row.updated_at || row.created_at || 0));
      if (Number.isNaN(existingUpdated) || rowUpdated > existingUpdated) {
        deduped.set(row.id, row);
      }
    }
    return [...deduped.values()];
  } catch {
    return [];
  }
}
function loadDraftState(): {
  executeOperationByToolId: Record<string, string>;
  executePayloadByToolId: Record<string, string>;
  hubtigerTestQueryByToolId: Record<string, string>;
  selectedModelByToolId: Record<string, string>;
} {
  try {
    const raw = localStorage.getItem(TOOL_DRAFTS_STORAGE_KEY);
    if (!raw) {
      return {
        executeOperationByToolId: {},
        executePayloadByToolId: {},
        hubtigerTestQueryByToolId: {},
        selectedModelByToolId: {},
      };
    }
    const parsed = JSON.parse(raw);
    return {
      executeOperationByToolId: parsed?.executeOperationByToolId && typeof parsed.executeOperationByToolId === 'object' ? parsed.executeOperationByToolId : {},
      executePayloadByToolId: parsed?.executePayloadByToolId && typeof parsed.executePayloadByToolId === 'object' ? parsed.executePayloadByToolId : {},
      hubtigerTestQueryByToolId: parsed?.hubtigerTestQueryByToolId && typeof parsed.hubtigerTestQueryByToolId === 'object' ? parsed.hubtigerTestQueryByToolId : {},
      selectedModelByToolId: parsed?.selectedModelByToolId && typeof parsed.selectedModelByToolId === 'object' ? parsed.selectedModelByToolId : {},
    };
  } catch {
    return {
      executeOperationByToolId: {},
      executePayloadByToolId: {},
      hubtigerTestQueryByToolId: {},
      selectedModelByToolId: {},
    };
  }
}
function parseJsonSafe(raw: string): unknown {
  try {
    return raw && raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function displayToolName(tool: Tool): string {
  if (tool.kind === 'shopify_mcp') return 'RideAI Commerce Module';
  if (tool.kind === 'odoo_rpc') return 'Odoo ERP Gateway';
  return tool.name;
}
function displayToolKind(tool: Tool): string {
  if (tool.kind === 'shopify_mcp') return 'rideai_commerce';
  if (tool.kind === 'odoo_rpc') return 'odoo_erp';
  return tool.kind;
}
function displayModelLabel(models: ModelRow[], modelUuid: string) {
  const model = models.find((row) => row.id === modelUuid);
  if (!model) return 'Auto';
  return String(model.label || model.model_id || model.id).trim() || modelUuid;
}

async function ensureShopifyToolExists(existingTools: Tool[]): Promise<Tool[]> {
  if (existingTools.some((t) => t.kind === 'shopify_mcp')) return existingTools;
  const res = await fetch('/api/tools', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'RideAI Commerce Module',
      kind: 'shopify_mcp',
      config: {
        version: 'v1',
        test_path: '/health',
        execute_path: '/tool',
      },
    }),
  });
  if (!res.ok) return existingTools;
  return fetchTools();
}
async function ensureOdooToolExists(existingTools: Tool[]): Promise<Tool[]> {
  if (existingTools.some((t) => t.kind === 'odoo_rpc')) return existingTools;
  const res = await fetch('/api/tools', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Odoo ERP',
      kind: 'odoo_rpc',
      config: { version: 'v1' },
    }),
  });
  if (!res.ok) return existingTools;
  return fetchTools();
}

function defaultPayloadForOperation(op: string): string {
  switch (op) {
    case 'shopify.products.search':
      return JSON.stringify({ query: 'scooter', limit: 5 }, null, 2);
    case 'shopify.orders.search':
      return JSON.stringify({ query: 'status:open', limit: 5 }, null, 2);
    case 'shopify.customers.search':
      return JSON.stringify({ query: 'email:*@', limit: 5 }, null, 2);
    case 'shopify.inventory.levels':
      return JSON.stringify({ limit: 10 }, null, 2);
    case 'shopify.analytics.sales_summary':
      return JSON.stringify({ start_date: '2026-01-01', end_date: '2026-03-31', granularity: 'month' }, null, 2);
    case 'sales_summary':
      return JSON.stringify({ start_date: '2026-01-01', end_date: '2026-03-31', group_by: 'month' }, null, 2);
    case 'top_products':
      return JSON.stringify({ start_date: '2026-01-01', end_date: '2026-03-31', sort_by: 'revenue', limit: 20 }, null, 2);
    case 'inventory_risk_report':
      return JSON.stringify({ days_of_cover_threshold: 21, low_stock_threshold: 5 }, null, 2);
    case 'product_vendor_performance':
      return JSON.stringify({ start_date: '2026-01-01', end_date: '2026-03-31', limit: 20 }, null, 2);
    case 'discount_performance':
      return JSON.stringify({ start_date: '2026-01-01', end_date: '2026-03-31' }, null, 2);
    case 'list_products':
      return JSON.stringify({ limit: 25, status: 'active' }, null, 2);
    case 'odoo.current_user':
    case 'odoo.meta.current_user':
    case 'odoo.meta.version':
      return JSON.stringify({}, null, 2);
    case 'odoo.meta.companies.list':
      return JSON.stringify({ limit: 10 }, null, 2);
    case 'odoo.products.search':
    case 'odoo.masters.products.search':
      return JSON.stringify({ query: 'Abus', limit: 10 }, null, 2);
    case 'odoo.customers.search':
    case 'odoo.masters.customers.search':
      return JSON.stringify({ query: 'Ride Electric', limit: 10 }, null, 2);
    case 'odoo.sale_orders.search':
    case 'odoo.sales.orders.search':
      return JSON.stringify({ query: '', limit: 10 }, null, 2);
    case 'odoo.invoices.search':
    case 'odoo.finance.invoices.search':
      return JSON.stringify({ query: '', limit: 10 }, null, 2);
    case 'odoo.finance.receivables.open':
    case 'odoo.finance.payables.open':
    case 'odoo.finance.journal_entries.search':
    case 'odoo.finance.payments.search':
    case 'odoo.inventory.quants.search':
    case 'odoo.inventory.valuation.search':
      return JSON.stringify({ limit: 20 }, null, 2);
    case 'odoo.finance.accounts.search':
    case 'odoo.purchasing.orders.search':
      return JSON.stringify({ query: '', limit: 20 }, null, 2);
    case 'odoo.search_read':
      return JSON.stringify({ model: 'res.partner', domain: [], fields: ['id', 'name'], limit: 10 }, null, 2);
    case 'odoo.execute_kw':
      return JSON.stringify({ model: 'res.partner', method: 'search_count', args: [[]], kwargs: {} }, null, 2);
    case 'jobs_search':
      return JSON.stringify({ q: 'Jeff Hall', allStores: false }, null, 2);
    case 'job_get':
      return JSON.stringify({ id: 4036225 }, null, 2);
    case 'job_messages':
      return JSON.stringify({ jobId: 4036225 }, null, 2);
    case 'messages_unread':
      return JSON.stringify({ page: 1, limit: 20 }, null, 2);
    case 'customer_search':
      return JSON.stringify({ q: '0435185134', type: 'phone', page: 0, limit: 20 }, null, 2);
    case 'bookings_week_samples':
      return JSON.stringify({ count: 3, distinctStores: true }, null, 2);
    case 'products_search':
      return JSON.stringify({ q: 'VSETT', limit: 15 }, null, 2);
    case 'booking_find_earliest':
      return JSON.stringify({ technicians: [2188, 2651, 2461], requiredMinutes: 60 }, null, 2);
    case 'availability_search':
      return JSON.stringify({ fromDate: '2026-03-10', toDate: '2026-03-17', technicians: [2188, 2651, 2461], requiredMinutes: 60 }, null, 2);
    case 'booking_create':
      return JSON.stringify({ ID: 2186, BikeID: 3566881, ServiceTypes: [32693], ServiceDate: '2026-03-23T08:00', PleaseBookIn: true, NewJobcardID: 34155, TechnicianID: 2461, isBikeHere: true }, null, 2);
    case 'booking_amend_slot':
      return JSON.stringify({ ID: 4036225, DateCheckedIn: '2026-03-23T08:00:00.000Z', TechnicianID: 2461 }, null, 2);
    case 'booking_amend':
      return JSON.stringify({ ID: 4036225, Duration: 120, PriceEstimate: 120 }, null, 2);
    case 'job_note_add':
      return JSON.stringify({ ID: 4036225, Note: 'Customer approved diagnostic work.', Date: '12/03/2026', visibility: 'customer' }, null, 2);
    case 'quote_add_line_item':
      return JSON.stringify({ ID: 0, Name: 'Diagnostic labour', UnitPrice_IncludingTax: 99, Quantity: 1, JobCardID: 4036225 }, null, 2);
    case 'quote_find_add':
      return JSON.stringify({ serviceId: 4037672, search: 'zero 11x controller', quantity: 1, dryRun: true }, null, 2);
    case 'quote_find_add_and_request_approval':
      return JSON.stringify({ serviceId: 4037672, search: 'zero 11x controller', quantity: 1, dryRun: true }, null, 2);
    case 'quote_request_approval':
      return JSON.stringify({ userId: 23889358, PartnerID: 2186, UserID: 23889358, CreatedBy: 2186, Title: 'Your quote has been updated', Message: 'Please review and approve the updated quote.', JobURLLink: 'https://hubtigerportal.azurewebsites.net/cyclist/jobcard-approval/4036225' }, null, 2);
    case 'portal_call':
      return JSON.stringify({ api: 'services', path: '/api/ServiceRequest/JobCardSearch', method: 'POST', auth: 'bearer', body: { PartnerID: 2186, Search: 'Jeff', SearchAllStores: false } }, null, 2);
    default:
      return '{}';
  }
}

export function Tools() {
  type ToolTab = 'shopify' | 'hubtiger' | 'odoo' | 'all';
  const initialDrafts = loadDraftState();
  const [tools, setTools] = useState<Tool[]>([]);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testedToolId, setTestedToolId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [hubtigerTestQueryByToolId, setHubtigerTestQueryByToolId] = useState<Record<string, string>>(initialDrafts.hubtigerTestQueryByToolId);
  const [executeResult, setExecuteResult] = useState<ExecuteResult | null>(null);
  const [executedToolId, setExecutedToolId] = useState<string | null>(null);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [executeOperationByToolId, setExecuteOperationByToolId] = useState<Record<string, string>>(initialDrafts.executeOperationByToolId);
  const [executePayloadByToolId, setExecutePayloadByToolId] = useState<Record<string, string>>(initialDrafts.executePayloadByToolId);
  const [presetRunningId, setPresetRunningId] = useState<string | null>(null);
  const [presetResultByToolId, setPresetResultByToolId] = useState<Record<string, ExecuteResult>>({});
  const [sampleBookingsByToolId, setSampleBookingsByToolId] = useState<Record<string, BookingSample[]>>({});
  const [shopifyDiagnosticsRunningId, setShopifyDiagnosticsRunningId] = useState<string | null>(null);
  const [shopifyDiagnosticsByToolId, setShopifyDiagnosticsByToolId] = useState<Record<string, ShopifyDiagnosticResult>>({});
  const [savedScenarios, setSavedScenarios] = useState<SavedScenario[]>([]);
  const [scenarioEditor, setScenarioEditor] = useState<ScenarioEditorState>({
    open: false,
    toolId: '',
    scenarioId: null,
    name: '',
    operation: '',
    payload: '{}',
    model_uuid: '',
  });
  const [selectedModelByToolId, setSelectedModelByToolId] = useState<Record<string, string>>(initialDrafts.selectedModelByToolId);
  const [draftMessageByToolId, setDraftMessageByToolId] = useState<Record<string, string>>({});
  const [shopifyConnectionByToolId, setShopifyConnectionByToolId] = useState<Record<string, ShopifyConnectionDraft>>({});
  const [shopifyConnectionSavingId, setShopifyConnectionSavingId] = useState<string | null>(null);
  const [shopifyConnectionMessageByToolId, setShopifyConnectionMessageByToolId] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<ToolTab>('shopify');
  const [analysisLoadingId, setAnalysisLoadingId] = useState<string | null>(null);
  const [analysisByToolId, setAnalysisByToolId] = useState<Record<string, string>>({});

  const getShopifyAuthOverride = (toolId: string) => {
    const draft = shopifyConnectionByToolId[toolId];
    if (!draft) return {};
    return {
      internal_key: String(draft.internal_key || '').trim(),
      api_token: String(draft.api_token || '').trim(),
    };
  };
  const isShopifyReadyForExecution = (tool: Tool) => {
    const draft = shopifyConnectionByToolId[tool.id];
    const hasEndpoint = String(draft?.base_url || tool.config?.base_url || '').trim().length > 0;
    const hasSecret = Boolean(tool.config?.internal_key_set || tool.config?.api_token_set || String(draft?.internal_key || '').trim() || String(draft?.api_token || '').trim());
    return hasEndpoint && hasSecret;
  };
  const isOdooReadyForExecution = (tool: Tool) => {
    const hasEndpoint = String(tool.config?.base_url || '').trim().length > 0;
    const hasDatabase = String(tool.config?.database || '').trim().length > 0;
    const hasUsername = String(tool.config?.username || '').trim().length > 0;
    const hasSecret = Boolean(tool.config?.api_key_set);
    return hasEndpoint && hasDatabase && hasUsername && hasSecret;
  };
  const selectedModelForTool = (toolId: string) => String(selectedModelByToolId[toolId] || '').trim();
  const scenariosForTool = (tool: Tool) =>
    savedScenarios.filter((scenario) =>
      scenario.tool_id
        ? scenario.tool_id === tool.id
        : scenario.tool_kind === tool.kind && tools.filter((row) => row.kind === tool.kind).length === 1
    );
  const openScenarioEditor = (tool: Tool, scenario?: SavedScenario | null) => {
    const fallbackOperation =
      executeOperationByToolId[tool.id]
      || (tool.kind === 'shopify_mcp' ? 'shopify.products.search' : tool.kind === 'odoo_rpc' ? 'odoo.current_user' : 'jobs_search');
    const fallbackPayload =
      executePayloadByToolId[tool.id]
      || defaultPayloadForOperation(fallbackOperation);
    setScenarioEditor({
      open: true,
      toolId: tool.id,
      scenarioId: scenario?.id || null,
      name: scenario?.name || '',
      operation: scenario?.operation || fallbackOperation,
      payload: scenario?.payload || fallbackPayload,
      model_uuid: scenario?.model_uuid || selectedModelForTool(tool.id),
    });
  };
  const saveScenarioEditor = () => {
    const tool = tools.find((row) => row.id === scenarioEditor.toolId);
    if (!tool) return;
    const name = scenarioEditor.name.trim();
    if (!name) return;
    const timestamp = new Date().toISOString();
    const nextScenario: SavedScenario = {
      id: scenarioEditor.scenarioId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tool_id: tool.id,
      tool_kind: tool.kind,
      name,
      operation: scenarioEditor.operation,
      payload: scenarioEditor.payload,
      model_uuid: scenarioEditor.model_uuid,
      created_at: scenarioEditor.scenarioId
        ? (savedScenarios.find((item) => item.id === scenarioEditor.scenarioId)?.created_at || timestamp)
        : timestamp,
      updated_at: timestamp,
    };
    setSavedScenarios((prev) => {
      const rest = prev.filter((item) => item.id !== nextScenario.id);
      return [nextScenario, ...rest].slice(0, 80);
    });
    setExecuteOperationByToolId((prev) => ({ ...prev, [tool.id]: scenarioEditor.operation }));
    setExecutePayloadByToolId((prev) => ({ ...prev, [tool.id]: scenarioEditor.payload }));
    setSelectedModelByToolId((prev) => ({ ...prev, [tool.id]: scenarioEditor.model_uuid }));
    setScenarioEditor((prev) => ({ ...prev, open: false }));
    setDraftMessageByToolId((prev) => ({ ...prev, [tool.id]: `Scenario "${name}" saved locally for this gateway.` }));
  };
  const runAiReview = async (toolId: string) => {
    const modelUuid = selectedModelForTool(toolId);
    const tool = tools.find((row) => row.id === toolId);
    if (!tool) return;
    const currentResult =
      executedToolId === toolId && executeResult
        ? executeResult
        : testedToolId === toolId && testResult
          ? testResult
          : null;
    if (!currentResult) {
      setAnalysisByToolId((prev) => ({ ...prev, [toolId]: 'Run Test or Execute first so there is data to analyze.' }));
      return;
    }
    setAnalysisLoadingId(toolId);
    try {
      const res = await fetch('/api/dashboard/llm/respond', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_uuid: modelUuid || undefined,
          prompt: [
            'You are reviewing a Tool Gateway integration test result.',
            'Summarize whether the integration is working, identify any validation or payload issues, and suggest the next best query.',
            '',
            `Tool kind: ${tool.kind}`,
            `Operation: ${executeOperationByToolId[toolId] || ''}`,
            `Payload: ${executePayloadByToolId[toolId] || ''}`,
            `Result: ${JSON.stringify(currentResult, null, 2)}`,
          ].join('\n'),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string; message?: string }).message || (body as { error?: string }).error || 'AI review failed');
      setAnalysisByToolId((prev) => ({ ...prev, [toolId]: String((body as { response?: string; text?: string; output?: string }).response || (body as any).text || (body as any).output || JSON.stringify(body, null, 2)) }));
    } catch (error) {
      setAnalysisByToolId((prev) => ({ ...prev, [toolId]: error instanceof Error ? error.message : 'AI review failed' }));
    } finally {
      setAnalysisLoadingId(null);
    }
  };

  const setOperationPayload = (toolId: string, operation: string, payloadObj: unknown) => {
    setExecuteOperationByToolId((prev) => ({ ...prev, [toolId]: operation }));
    setExecutePayloadByToolId((prev) => ({ ...prev, [toolId]: JSON.stringify(payloadObj, null, 2) }));
  };

  useEffect(() => {
    fetchTools()
      .then(ensureShopifyToolExists)
      .then(ensureOdooToolExists)
      .then(setTools)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setSavedScenarios(loadSavedScenarios());
  }, []);

  useEffect(() => {
    fetchModels().then(setModels).catch(() => setModels([]));
  }, []);

  useEffect(() => {
    localStorage.setItem(TOOL_SCENARIOS_STORAGE_KEY, JSON.stringify(savedScenarios));
  }, [savedScenarios]);

  useEffect(() => {
    localStorage.setItem(
      TOOL_DRAFTS_STORAGE_KEY,
      JSON.stringify({
        executeOperationByToolId,
        executePayloadByToolId,
        hubtigerTestQueryByToolId,
        selectedModelByToolId,
      })
    );
  }, [executeOperationByToolId, executePayloadByToolId, hubtigerTestQueryByToolId, selectedModelByToolId]);
  useEffect(() => {
    setShopifyConnectionByToolId((prev) => {
      const next = { ...prev };
      for (const tool of tools) {
        if (tool.kind !== 'shopify_mcp') continue;
        if (next[tool.id]) continue;
        next[tool.id] = {
          base_url: String((tool.config?.base_url as string) || ''),
          test_path: String((tool.config?.test_path as string) || '/health'),
          execute_path: String((tool.config?.execute_path as string) || '/tool'),
          internal_key: '',
          api_token: '',
        };
      }
      return next;
    });
  }, [tools]);

  const refreshGateways = async () => {
    setLoading(true);
    setError(null);
    try {
      const base = await fetchTools();
      const withShopify = await ensureShopifyToolExists(base);
      const withOdoo = await ensureOdooToolExists(withShopify);
      setTools(withOdoo);
      setDraftMessageByToolId((prev) => ({ ...prev, __global__: 'Gateways reloaded without page refresh.' }));
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  };

  const onTest = (toolId: string) => {
    setTestingId(toolId);
    setTestResult(null);
    setTestedToolId(null);
    const q = hubtigerTestQueryByToolId[toolId] ?? '';
    testTool(toolId, q, getShopifyAuthOverride(toolId))
      .then((r) => {
        setTestResult(r);
        setTestedToolId(toolId);
      })
      .catch((e) => {
        setTestResult({ ok: false, error: e.message });
        setTestedToolId(toolId);
      })
      .finally(() => setTestingId(null));
  };

  const onExecute = (toolId: string) => {
    setExecutingId(toolId);
    setExecuteResult(null);
    setExecutedToolId(null);
    const tool = tools.find((t) => t.id === toolId);
    if (tool?.kind === 'shopify_mcp' && !isShopifyReadyForExecution(tool)) {
      setExecuteResult({ ok: false, error: 'Shopify module offline: set endpoint and at least one auth secret (env or session override).' });
      setExecutedToolId(toolId);
      setExecutingId(null);
      return;
    }
    if (tool?.kind === 'odoo_rpc' && !isOdooReadyForExecution(tool)) {
      setExecuteResult({ ok: false, error: 'Odoo gateway offline: set URL, database, username, and API key in environment.' });
      setExecutedToolId(toolId);
      setExecutingId(null);
      return;
    }
    const defaultOperation =
      tool?.kind === 'shopify_mcp'
        ? 'shopify.products.search'
        : tool?.kind === 'odoo_rpc'
          ? 'odoo.current_user'
          : 'jobs_search';
    const operation = executeOperationByToolId[toolId] ?? defaultOperation;
    const rawPayload = executePayloadByToolId[toolId] ?? defaultPayloadForOperation(operation);
    let parsedPayload: unknown = {};
    try {
      parsedPayload = rawPayload.trim() ? JSON.parse(rawPayload) : {};
    } catch {
      setExecuteResult({ ok: false, error: 'Payload must be valid JSON' });
      setExecutedToolId(toolId);
      setExecutingId(null);
      return;
    }
    executeTool(toolId, operation, parsedPayload, getShopifyAuthOverride(toolId))
      .then((r) => {
        setExecuteResult(r);
        setExecutedToolId(toolId);
      })
      .catch((e) => {
        setExecuteResult({ ok: false, error: e.message });
        setExecutedToolId(toolId);
      })
      .finally(() => setExecutingId(null));
  };

  const loadWeeklySamplesPreset = async (toolId: string) => {
    setPresetRunningId(toolId);
    setPresetResultByToolId((prev) => ({ ...prev, [toolId]: { ok: true, step: 'loading_weekly_samples' } }));
    const result = await executeTool(toolId, 'bookings_week_samples', { count: 3, distinctStores: true });
    if (!result.ok) {
      setPresetResultByToolId((prev) => ({ ...prev, [toolId]: result }));
      setPresetRunningId(null);
      return;
    }
    const samples = Array.isArray((result as any)?.data?.samples) ? (result as any).data.samples as BookingSample[] : [];
    setSampleBookingsByToolId((prev) => ({ ...prev, [toolId]: samples }));
    if (samples[0]) {
      setOperationPayload(toolId, 'job_get', { id: samples[0].serviceID });
    }
    setPresetResultByToolId((prev) => ({
      ...prev,
      [toolId]: {
        ok: true,
        step: 'weekly_samples_loaded',
        sampleCount: samples.length,
        samples,
        hint: 'Sample #1 auto-loaded into execute payload for job_get.',
      },
    }));
    setPresetRunningId(null);
  };

  const quoteOneClickPreset = async (toolId: string) => {
    setPresetRunningId(toolId);
    const stepLogs: Record<string, unknown> = {};
    try {
      let samples = sampleBookingsByToolId[toolId] || [];
      if (!samples.length) {
      const weekly = await executeTool(toolId, 'bookings_week_samples', { count: 3, distinctStores: true });
        stepLogs.weekly_samples = weekly;
        if (!weekly.ok) throw new Error((weekly.error as string) || 'Failed loading weekly samples');
        samples = Array.isArray((weekly as any)?.data?.samples) ? (weekly as any).data.samples : [];
        setSampleBookingsByToolId((prev) => ({ ...prev, [toolId]: samples }));
      }
      if (!samples.length) throw new Error('No sample bookings returned for this week.');
      const sample = samples[0];

      const products = await executeTool(toolId, 'products_search', { q: sample.bike || 'service', limit: 10 });
      stepLogs.products_search = products;
      if (!products.ok) throw new Error((products.error as string) || 'Failed product search');
      const product = Array.isArray((products as any)?.data?.results) ? (products as any).data.results[0] : null;
      if (!product) throw new Error('No product found for quote test.');

      const lineItemPayload = {
        ID: 0,
        ExternalProductID: product.externalProductId ?? product.sku ?? '',
        SKU: product.sku ?? '',
        Name: product.name ?? 'Quote item',
        Description: product.description ?? product.name ?? 'Quote item',
        UnitPrice: product.unitPrice ?? 0,
        UnitPrice_IncludingTax: product.unitPriceIncludingTax ?? product.unitPrice ?? 0,
        Tax: product.tax ?? 0,
        Quantity: 1,
        JobCardID: sample.serviceID,
      };
      const addLine = await executeTool(toolId, 'quote_add_line_item', lineItemPayload);
      stepLogs.quote_add_line_item = addLine;
      if (!addLine.ok) throw new Error((addLine.error as string) || 'Failed adding line item');

      const approvalPayload = {
        userId: sample.customerID,
        PartnerID: 2186,
        UserID: sample.customerID,
        CreatedBy: 2186,
        Title: 'Your invoice has been updated',
        Message: `Ride Electric added ${product.name || 'an item'} to your pending quote and requests approval.`,
        JobURLLink: `https://hubtigerportal.azurewebsites.net/cyclist/jobcard-approval/${sample.serviceID}`,
      };
      const approval = await executeTool(toolId, 'quote_request_approval', approvalPayload);
      stepLogs.quote_request_approval = approval;
      if (!approval.ok) throw new Error((approval.error as string) || 'Failed requesting approval');

      setOperationPayload(toolId, 'quote_request_approval', approvalPayload);
      setPresetResultByToolId((prev) => ({
        ...prev,
        [toolId]: {
          ok: true,
          preset: 'quote_one_click',
          sample,
          product,
          message: 'Added line item and requested customer approval.',
          steps: stepLogs,
        },
      }));
    } catch (err: any) {
      setPresetResultByToolId((prev) => ({
        ...prev,
        [toolId]: { ok: false, preset: 'quote_one_click', error: String(err?.message || err), steps: stepLogs },
      }));
    } finally {
      setPresetRunningId(null);
    }
  };

  const fillFromSample = (toolId: string, sample: BookingSample, mode: 'job' | 'messages' | 'note') => {
    if (mode === 'job') {
      setOperationPayload(toolId, 'job_get', { id: sample.serviceID });
      return;
    }
    if (mode === 'messages') {
      setOperationPayload(toolId, 'job_messages', { jobId: sample.serviceID });
      return;
    }
    setOperationPayload(toolId, 'job_note_add', {
      ID: sample.serviceID,
      Note: `Customer update for ${sample.customerName}`,
      Date: new Date().toLocaleDateString('en-GB'),
      visibility: 'customer',
    });
  };

  const runShopifyDiagnostics = async (toolId: string) => {
    const tool = tools.find((t) => t.id === toolId);
    if (!tool || !isShopifyReadyForExecution(tool)) {
      setShopifyDiagnosticsByToolId((prev) => ({
        ...prev,
        [toolId]: { ok: false, steps: [], summary: 'Shopify module offline: configure endpoint and auth first.' },
      }));
      return;
    }
    setShopifyDiagnosticsRunningId(toolId);
    const checks: Array<{ operation: string; payload: unknown }> = [
      { operation: 'shopify.products.search', payload: { query: 'status:active', limit: 3 } },
      { operation: 'shopify.orders.search', payload: { query: 'status:open', limit: 3 } },
      { operation: 'shopify.customers.search', payload: { query: 'email:*@', limit: 3 } },
    ];
    const steps: ShopifyDiagnosticResult['steps'] = [];
    for (const check of checks) {
      const r = await executeTool(toolId, check.operation, check.payload, getShopifyAuthOverride(toolId));
      steps.push({
        operation: check.operation,
        ok: r.ok === true,
        latency_ms: Number(r.latency_ms || 0) || undefined,
        error: r.ok === true ? undefined : String(r.error || 'failed'),
      });
    }
    const passed = steps.filter((s) => s.ok).length;
    setShopifyDiagnosticsByToolId((prev) => ({
      ...prev,
      [toolId]: {
        ok: passed === steps.length,
        steps,
        summary: `${passed}/${steps.length} checks passed`,
      },
    }));
    setShopifyDiagnosticsRunningId(null);
  };
  const runSavedScenario = async (toolId: string, scenario: SavedScenario) => {
    setExecutingId(toolId);
    setExecutedToolId(toolId);
    try {
      const parsed = scenario.payload.trim() ? JSON.parse(scenario.payload) : {};
      const res = await executeTool(toolId, scenario.operation, parsed, getShopifyAuthOverride(toolId));
      setExecuteResult(res);
      setExecuteOperationByToolId((prev) => ({ ...prev, [toolId]: scenario.operation }));
      setExecutePayloadByToolId((prev) => ({ ...prev, [toolId]: scenario.payload }));
      setSelectedModelByToolId((prev) => ({ ...prev, [toolId]: scenario.model_uuid || '' }));
    } catch {
      setExecuteResult({ ok: false, error: 'Saved scenario has invalid JSON payload' });
    } finally {
      setExecutingId(null);
    }
  };
  const runFinancialOptimizationPack = async (toolId: string) => {
    const tool = tools.find((t) => t.id === toolId);
    if (!tool || !isShopifyReadyForExecution(tool)) {
      setShopifyDiagnosticsByToolId((prev) => ({
        ...prev,
        [toolId]: { ok: false, steps: [], summary: 'Shopify module offline: configure endpoint and auth first.' },
      }));
      return;
    }
    setShopifyDiagnosticsRunningId(toolId);
    const checks: Array<{ operation: string; payload: unknown }> = [
      { operation: 'top_products', payload: { start_date: '2026-01-01', end_date: '2026-03-31', sort_by: 'revenue', limit: 30 } },
      { operation: 'inventory_risk_report', payload: { days_of_cover_threshold: 21, low_stock_threshold: 5 } },
      { operation: 'product_vendor_performance', payload: { start_date: '2026-01-01', end_date: '2026-03-31', limit: 20 } },
      { operation: 'discount_performance', payload: { start_date: '2026-01-01', end_date: '2026-03-31' } },
      { operation: 'sales_summary', payload: { start_date: '2026-01-01', end_date: '2026-03-31', group_by: 'month' } },
    ];
    const steps: ShopifyDiagnosticResult['steps'] = [];
    for (const check of checks) {
      const r = await executeTool(toolId, check.operation, check.payload, getShopifyAuthOverride(toolId));
      steps.push({
        operation: check.operation,
        ok: r.ok === true,
        latency_ms: Number(r.latency_ms || 0) || undefined,
        error: r.ok === true ? undefined : String(r.error || 'failed'),
      });
    }
    const passed = steps.filter((s) => s.ok).length;
    setShopifyDiagnosticsByToolId((prev) => ({
      ...prev,
      [toolId]: {
        ok: passed === steps.length,
        steps,
        summary: `${passed}/${steps.length} financial checks passed`,
      },
    }));
    setShopifyDiagnosticsRunningId(null);
  };
  const saveShopifyConnection = async (tool: Tool) => {
    const draft = shopifyConnectionByToolId[tool.id];
    if (!draft) return;
    setShopifyConnectionSavingId(tool.id);
    setShopifyConnectionMessageByToolId((prev) => ({ ...prev, [tool.id]: '' }));
    try {
      const nextConfig: Record<string, unknown> = {
        ...(tool.config || {}),
        version: String((tool.config?.version as string) || 'v1'),
        base_url: draft.base_url.trim(),
        test_path: draft.test_path.trim() || '/health',
        execute_path: draft.execute_path.trim() || '/tool',
      };
      delete nextConfig.internal_key_set;
      delete nextConfig.api_token_set;
      delete nextConfig.internal_key;
      delete nextConfig.api_token;
      const res = await fetch('/api/tools', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: tool.name,
          kind: tool.kind,
          config: nextConfig,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as any)?.error || 'Failed to save Shopify connection');
      const refreshed = await fetchTools();
      setTools(refreshed);
      setShopifyConnectionByToolId((prev) => ({
        ...prev,
        [tool.id]: {
          ...prev[tool.id],
          internal_key: '',
          api_token: '',
        },
      }));
      setShopifyConnectionMessageByToolId((prev) => ({ ...prev, [tool.id]: 'Connection settings saved.' }));
    } catch (e: any) {
      setShopifyConnectionMessageByToolId((prev) => ({ ...prev, [tool.id]: String(e?.message || e) }));
    } finally {
      setShopifyConnectionSavingId(null);
    }
  };
  const tabCounts = {
    shopify: tools.filter((t) => t.kind === 'shopify_mcp').length,
    hubtiger: tools.filter((t) => t.kind === 'hubtiger').length,
    odoo: tools.filter((t) => t.kind === 'odoo_rpc').length,
    all: tools.length,
  };
  const visibleTools = tools.filter((tool) => {
    if (activeTab === 'all') return true;
    if (activeTab === 'shopify') return tool.kind === 'shopify_mcp';
    if (activeTab === 'odoo') return tool.kind === 'odoo_rpc';
    return tool.kind === 'hubtiger';
  });
  const selectedGatewayTitle =
    activeTab === 'shopify'
      ? 'RideAI Commerce Gateway'
      : activeTab === 'hubtiger'
        ? 'Hubtiger Operations Gateway'
        : activeTab === 'odoo'
          ? 'Odoo ERP Gateway'
          : 'Unified Gateway View';
  const selectedGatewayDescription =
    activeTab === 'shopify'
      ? 'Native RideAI commerce actions, diagnostics, and financial workflows.'
      : activeTab === 'hubtiger'
        ? 'Operational workflow tooling for service desks and workshop orchestration.'
        : activeTab === 'odoo'
          ? 'ERP search and operational reads through GhostDash with server-side Odoo auth.'
        : 'Cross-module view for all registered tools and API integrations.';

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-6xl mx-auto space-y-6"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1
            className="page-title-accent text-3xl font-semibold tracking-tight"
            title="Control secure server-side access to external tools, APIs, and MCP-backed integrations."
          >
            Tool Gateway
          </h1>
          <p className="text-white/50 mt-1 text-sm">Manage server-side tool access, integration state, and live availability for your agents.</p>
        </div>

        <button
          className="glass-button-primary w-full sm:w-auto px-4 py-2 rounded-xl flex items-center justify-center gap-2 text-sm font-medium"
          title="Reload secure tool and integration registry without a page refresh."
          onClick={() => void refreshGateways()}
        >
          <Plus size={16} />
          Reload Gateways
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)] gap-4 items-start">
        <div className="surface-panel p-3">
          <div className="space-y-2">
            {[
              { id: 'shopify' as ToolTab, label: 'Commerce Gateway', sub: 'Managed Shopify intelligence and actions', count: tabCounts.shopify, icon: <Store size={16} /> },
              { id: 'hubtiger' as ToolTab, label: 'Service Gateway', sub: 'Bookings, jobs, and workshop workflow', count: tabCounts.hubtiger, icon: <BriefcaseBusiness size={16} /> },
              { id: 'odoo' as ToolTab, label: 'ERP Gateway', sub: 'Odoo operational and financial reads', count: tabCounts.odoo, icon: <Building2 size={16} /> },
              { id: 'all' as ToolTab, label: 'All Gateways', sub: 'Every registered tool surface in one view', count: tabCounts.all, icon: <Layers3 size={16} /> },
            ].map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`nav-item relative w-full overflow-hidden rounded-xl px-4 py-4 text-left transition-all border ${
                    selected ? 'active' : 'bg-white/[0.03]'
                  }`}
                >
                  {selected && (
                    <motion.span
                      layoutId="tools-tab-active-pill"
                      transition={{ type: 'spring', stiffness: 360, damping: 30, mass: 0.6 }}
                      className="absolute inset-0 bg-gradient-to-r from-emerald-500/10 to-sky-400/8"
                    />
                  )}
                  <div className="relative z-10 flex items-center justify-between gap-2">
                    <span className={`inline-flex items-center gap-2 text-sm font-semibold ${selected ? 'text-white' : 'text-white/85'}`}>
                      {tab.icon}
                      {tab.label}
                    </span>
                    <span className={`text-[11px] px-2 py-0.5 rounded border ${selected ? 'border-emerald-300/30 text-emerald-100 bg-emerald-500/10' : 'border-white/15 text-white/60 bg-white/[0.03]'}`}>
                      {tab.count}
                    </span>
                  </div>
                  <div className={`relative z-10 mt-1 text-[11px] ${selected ? 'text-emerald-100/80' : 'text-white/45'}`}>{tab.sub}</div>
                </button>
              );
            })}
          </div>
        </div>
        <div className="space-y-4">
          <div className="control-strip p-4">
            <div className="module-meta-strip">
              <div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-soft)]">Selected Gateway</div>
                <div className="mt-1 text-lg font-semibold text-[var(--text-dark)]">{selectedGatewayTitle}</div>
                <div className="mt-1 text-sm text-[var(--text-mid)]">{selectedGatewayDescription}</div>
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--text-mid)]">
                <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-emerald-100">
                  <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_10px_rgba(25,227,122,0.7)]" />
                  {visibleTools.length} active view
                </span>
              </div>
            </div>
          </div>

          <div className={`grid grid-cols-1 ${visibleTools.length > 1 ? 'lg:grid-cols-2' : ''} gap-4`}>
            {visibleTools.map((tool) => {
              const toolScenarios = scenariosForTool(tool);
              return (
              <div key={tool.id} className="glass-panel rounded-2xl p-5 sm:p-6 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-3xl -mr-10 -mt-10"></div>

                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-4 relative z-10">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 flex items-center justify-center">
                      <Wrench size={24} className="text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold flex items-center gap-2">
                        {displayToolName(tool)}
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 uppercase tracking-wider">
                          {tool.status}
                        </span>
                      </h3>
                      <p className="text-sm text-white/50">kind: {displayToolKind(tool)}</p>
                    </div>
                  </div>
                  <button
                    className="glass-button w-full sm:w-auto px-3 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5"
                    disabled={testingId === tool.id}
                    onClick={() => onTest(tool.id)}
                  >
                    {testingId === tool.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    Test
                  </button>
                </div>

                {testResult !== null && testedToolId === tool.id ? (
                  <div className="relative z-10 mb-4 rounded-xl p-3 text-sm font-mono bg-black/30 border border-white/10 space-y-1">
                    {testResult.ok ? (
                      <>
                        <div className="text-emerald-400">
                          OK · {testResult.status ?? 200} · {testResult.latency_ms ?? 0}ms
                        </div>
                        {testResult.trace_id && (
                          <div className="text-white/50 text-xs truncate" title={testResult.trace_id}>
                            trace_id: {testResult.trace_id}
                          </div>
                        )}
                        {(testResult.retry_count !== undefined || testResult.cache_hit !== undefined || testResult.circuit_state) && (
                          <div className="text-white/50 text-xs">
                            mcp: retry={testResult.retry_count ?? 0} · cache_hit={String(testResult.cache_hit === true)} · circuit={testResult.circuit_state ?? 'closed'}
                          </div>
                        )}
                        {testResult.response_snippet && (
                          <pre className="text-xs text-white/60 mt-2 whitespace-pre-wrap break-all max-h-24 overflow-y-auto">
                            {testResult.response_snippet}
                          </pre>
                        )}
                      </>
                    ) : (
                      <span className="text-red-400">{testResult.error ?? 'Request failed'}</span>
                    )}
                  </div>
                ) : null}

                <div className="space-y-4 relative z-10">

              {tool.kind === 'hubtiger' && (
                <div className="glass-panel rounded-xl p-4 bg-black/20 border-white/5">
                  <div className="flex items-center gap-2 text-sm text-white/70 mb-2">
                    <Wrench size={14} />
                    <span className="font-medium">Testing query</span>
                    <span className="text-xs text-white/40">(Hubtiger search)</span>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      className="glass-input flex-1 px-3 py-2 rounded-lg text-sm"
                      placeholder='e.g. "Bob Bowen" or "+61412..." or "33743"'
                      value={hubtigerTestQueryByToolId[tool.id] ?? ''}
                      onChange={(e) =>
                        setHubtigerTestQueryByToolId((prev) => ({ ...prev, [tool.id]: e.target.value }))
                      }
                    />
                    <button
                      className="glass-button px-3 py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5"
                      disabled={testingId === tool.id}
                      onClick={() => onTest(tool.id)}
                      title="Run test query"
                    >
                      {testingId === tool.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                      Run
                    </button>
                  </div>
                  <div className="text-xs text-white/40 mt-2">
                    Sends <code className="text-white/60">{"{ query }"}</code> to{' '}
                    <code className="text-white/60">POST /api/tools/{tool.id}/test</code>
                  </div>
                </div>
              )}
              {(tool.kind === 'hubtiger' || tool.kind === 'shopify_mcp' || tool.kind === 'odoo_rpc') && (
                <div className="glass-panel rounded-xl p-4 bg-black/20 border-white/5">
                  <div className="flex items-center gap-2 text-sm text-white/70 mb-2">
                    <Wrench size={14} />
                    <span className="font-medium">
                      {tool.kind === 'shopify_mcp' ? 'RideAI Commerce execute' : tool.kind === 'odoo_rpc' ? 'Odoo ERP execute' : 'Advanced execute'}
                    </span>
                    <span className="text-xs text-white/40">
                      {tool.kind === 'shopify_mcp' || tool.kind === 'odoo_rpc' ? '(operation + payload)' : '(new operations)'}
                    </span>
                  </div>
                  <div className="space-y-2">
                    <div className="rounded-lg bg-black/30 border border-white/10 p-3 space-y-2">
                      <div className="text-[11px] text-white/50 uppercase tracking-wide">Analysis Model</div>
                      <select
                        className="glass-input w-full px-3 py-2 rounded-lg text-xs bg-transparent"
                        value={selectedModelForTool(tool.id)}
                        onChange={(e) => setSelectedModelByToolId((prev) => ({ ...prev, [tool.id]: e.target.value }))}
                      >
                        <option value="">Auto (no model override)</option>
                        {models.map((model) => (
                          <option key={model.id} value={model.id} className="bg-slate-900">
                            {displayModelLabel(models, model.id)}
                          </option>
                        ))}
                      </select>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium inline-flex items-center gap-1.5"
                          onClick={() => setDraftMessageByToolId((prev) => ({ ...prev, [tool.id]: 'Draft saved locally automatically.' }))}
                        >
                          <Save size={12} />
                          Drafts Auto-Save
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium inline-flex items-center gap-1.5"
                          onClick={() => openScenarioEditor(tool)}
                        >
                          <Pencil size={12} />
                          Save Scenario
                        </button>
                      </div>
                      <div className="text-[10px] text-white/45">
                        Used for AI review only. Upstream API calls still run directly against the selected gateway.
                      </div>
                      {draftMessageByToolId[tool.id] ? (
                        <div className="text-[11px] text-white/60">{draftMessageByToolId[tool.id]}</div>
                      ) : null}
                    </div>
                    {tool.kind === 'shopify_mcp' && (
                      <div className="rounded-lg bg-blue-500/10 border border-blue-400/20 p-3 text-xs text-blue-100/90 space-y-2">
                        <div className="font-semibold text-blue-200">RideAI Commerce Command Center</div>
                        <div>
                          Fully managed by GhostDash control-plane as a native RideAI module for product, order, customer, inventory, and financial analytics.
                        </div>
                        <div className="text-blue-100/80">
                          Operated by RideAI: run diagnostics first, then execute deeper financial scenarios below.
                        </div>
                        <div className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider px-2 py-1 rounded border border-cyan-300/30 bg-cyan-500/10 text-cyan-200">
                          RideAI Managed Module
                        </div>
                      </div>
                    )}
                    {tool.kind === 'shopify_mcp' && !isShopifyReadyForExecution(tool) && (
                      <div className="rounded-lg bg-amber-500/10 border border-amber-400/30 p-3 text-xs text-amber-100">
                        Module offline: configure API endpoint and provide auth via environment or session override fields below.
                      </div>
                    )}
                    {tool.kind === 'odoo_rpc' && (
                      <div className="rounded-lg bg-blue-500/10 border border-blue-400/20 p-3 text-xs text-blue-100/90 space-y-2">
                        <div className="font-semibold text-blue-200">Odoo ERP Gateway</div>
                        <div>
                          GhostDash now routes Odoo reads through an internal `odoo-rpc` service. Odoo credentials stay server-side and the browser still only calls `/api/*`.
                        </div>
                        <div className="flex flex-wrap gap-2 text-[10px]">
                          <span className={`px-2 py-0.5 rounded border ${tool.config?.base_url ? 'border-emerald-400/30 text-emerald-300 bg-emerald-500/10' : 'border-amber-400/30 text-amber-200 bg-amber-500/10'}`}>
                            Gateway URL {tool.config?.base_url ? 'set' : 'missing'}
                          </span>
                          <span className={`px-2 py-0.5 rounded border ${tool.config?.database ? 'border-emerald-400/30 text-emerald-300 bg-emerald-500/10' : 'border-amber-400/30 text-amber-200 bg-amber-500/10'}`}>
                            Odoo DB {tool.config?.database ? 'set' : 'missing'}
                          </span>
                          <span className={`px-2 py-0.5 rounded border ${tool.config?.username ? 'border-emerald-400/30 text-emerald-300 bg-emerald-500/10' : 'border-amber-400/30 text-amber-200 bg-amber-500/10'}`}>
                            Odoo Login {tool.config?.username ? 'set' : 'missing'}
                          </span>
                          <span className={`px-2 py-0.5 rounded border ${tool.config?.api_key_set ? 'border-emerald-400/30 text-emerald-300 bg-emerald-500/10' : 'border-amber-400/30 text-amber-200 bg-amber-500/10'}`}>
                            Odoo Secret {tool.config?.api_key_set ? 'set' : 'missing'}
                          </span>
                        </div>
                      </div>
                    )}
                    {tool.kind === 'odoo_rpc' && !isOdooReadyForExecution(tool) && (
                      <div className="rounded-lg bg-amber-500/10 border border-amber-400/30 p-3 text-xs text-amber-100">
                        Odoo gateway offline: set `ODOO_RPC_URL` plus the Odoo URL, database, username, and secret in the environment.
                      </div>
                    )}
                    {tool.kind === 'shopify_mcp' && (
                      <div className="rounded-lg bg-black/30 border border-white/10 p-3 space-y-2">
                        <div className="text-[11px] text-white/50 uppercase tracking-wide">Shopify Connection</div>
                        <div className="flex flex-wrap gap-2 text-[10px]">
                          <span className={`px-2 py-0.5 rounded border ${tool.config?.internal_key_set ? 'border-emerald-400/30 text-emerald-300 bg-emerald-500/10' : 'border-amber-400/30 text-amber-200 bg-amber-500/10'}`}>
                            Internal key {tool.config?.internal_key_set ? 'set' : 'missing'}
                          </span>
                          <span className={`px-2 py-0.5 rounded border ${tool.config?.api_token_set ? 'border-emerald-400/30 text-emerald-300 bg-emerald-500/10' : 'border-amber-400/30 text-amber-200 bg-amber-500/10'}`}>
                            API token {tool.config?.api_token_set ? 'set' : 'missing'}
                          </span>
                        </div>
                        <div className="text-[10px] text-white/45">
                          Session override secrets entered below are used immediately for test/execute and are not persisted to the database.
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <input
                            className="glass-input px-3 py-2 rounded-lg text-xs"
                            placeholder="API endpoint (e.g. https://shopify-mcp.internal)"
                            value={shopifyConnectionByToolId[tool.id]?.base_url ?? ''}
                            onChange={(e) => setShopifyConnectionByToolId((prev) => ({
                              ...prev,
                              [tool.id]: { ...(prev[tool.id] || { base_url: '', test_path: '/health', execute_path: '/tool', internal_key: '', api_token: '' }), base_url: e.target.value },
                            }))}
                          />
                          <input
                            className="glass-input px-3 py-2 rounded-lg text-xs"
                            placeholder="Health path (default /health)"
                            value={shopifyConnectionByToolId[tool.id]?.test_path ?? '/health'}
                            onChange={(e) => setShopifyConnectionByToolId((prev) => ({
                              ...prev,
                              [tool.id]: { ...(prev[tool.id] || { base_url: '', test_path: '/health', execute_path: '/tool', internal_key: '', api_token: '' }), test_path: e.target.value },
                            }))}
                          />
                          <input
                            className="glass-input px-3 py-2 rounded-lg text-xs"
                            placeholder="Execute path (default /tool)"
                            value={shopifyConnectionByToolId[tool.id]?.execute_path ?? '/tool'}
                            onChange={(e) => setShopifyConnectionByToolId((prev) => ({
                              ...prev,
                              [tool.id]: { ...(prev[tool.id] || { base_url: '', test_path: '/health', execute_path: '/tool', internal_key: '', api_token: '' }), execute_path: e.target.value },
                            }))}
                          />
                          <input
                            type="password"
                            className="glass-input px-3 py-2 rounded-lg text-xs"
                            placeholder="Internal key (x-internal-key)"
                            value={shopifyConnectionByToolId[tool.id]?.internal_key ?? ''}
                            onChange={(e) => setShopifyConnectionByToolId((prev) => ({
                              ...prev,
                              [tool.id]: { ...(prev[tool.id] || { base_url: '', test_path: '/health', execute_path: '/tool', internal_key: '', api_token: '' }), internal_key: e.target.value },
                            }))}
                          />
                          <input
                            type="password"
                            className="glass-input px-3 py-2 rounded-lg text-xs md:col-span-2"
                            placeholder="API token (sent as Bearer token)"
                            value={shopifyConnectionByToolId[tool.id]?.api_token ?? ''}
                            onChange={(e) => setShopifyConnectionByToolId((prev) => ({
                              ...prev,
                              [tool.id]: { ...(prev[tool.id] || { base_url: '', test_path: '/health', execute_path: '/tool', internal_key: '', api_token: '' }), api_token: e.target.value },
                            }))}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                            disabled={shopifyConnectionSavingId === tool.id}
                            onClick={() => saveShopifyConnection(tool)}
                          >
                            {shopifyConnectionSavingId === tool.id ? 'Saving…' : 'Save Shopify connection'}
                          </button>
                          {shopifyConnectionMessageByToolId[tool.id] && (
                            <span className="text-[11px] text-white/60">{shopifyConnectionMessageByToolId[tool.id]}</span>
                          )}
                        </div>
                      </div>
                    )}
                    {tool.kind === 'hubtiger' && <div className="flex flex-wrap gap-2">
                      <button
                        className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                        disabled={presetRunningId === tool.id}
                        onClick={() => loadWeeklySamplesPreset(tool.id)}
                      >
                        {presetRunningId === tool.id ? 'Running…' : 'Preset: Load week samples'}
                      </button>
                      <button
                        className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                        disabled={presetRunningId === tool.id}
                        onClick={() => quoteOneClickPreset(tool.id)}
                      >
                        {presetRunningId === tool.id ? 'Running…' : 'Preset: One-click quote + approval'}
                      </button>
                      <button
                        className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                        disabled={presetRunningId === tool.id}
                        onClick={() => setOperationPayload(tool.id, 'booking_find_earliest', { technicians: [2188, 2651, 2461], requiredMinutes: 60 })}
                      >
                        Preset: Earliest slot
                      </button>
                    </div>}
                    {tool.kind === 'shopify_mcp' && (
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          disabled={shopifyDiagnosticsRunningId === tool.id}
                          onClick={() => runShopifyDiagnostics(tool.id)}
                        >
                          {shopifyDiagnosticsRunningId === tool.id ? 'Running…' : 'Run Shopify diagnostics'}
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          disabled={shopifyDiagnosticsRunningId === tool.id}
                          onClick={() => runFinancialOptimizationPack(tool.id)}
                        >
                          {shopifyDiagnosticsRunningId === tool.id ? 'Running…' : 'Run financial optimization pack'}
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'shopify.products.search', { query: 'title:scooter', limit: 10 })}
                        >
                          Preset: Product search
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'shopify.analytics.sales_summary', { start_date: '2026-01-01', end_date: '2026-03-31', granularity: 'month' })}
                        >
                          Preset: Sales summary
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'top_products', { start_date: '2026-01-01', end_date: '2026-03-31', sort_by: 'revenue', limit: 20 })}
                        >
                          Preset: Top products
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'inventory_risk_report', { days_of_cover_threshold: 21, low_stock_threshold: 5 })}
                        >
                          Preset: Risk report
                        </button>
                      </div>
                    )}
                    {tool.kind === 'odoo_rpc' && (
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'odoo.meta.current_user', {})}
                        >
                          Preset: Current user
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'odoo.masters.products.search', { query: 'Abus', limit: 10 })}
                        >
                          Preset: Products
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'odoo.masters.customers.search', { query: 'Ride Electric', limit: 10 })}
                        >
                          Preset: Customers
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'odoo.sales.orders.search', { query: '', limit: 10 })}
                        >
                          Preset: Sale orders
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'odoo.finance.invoices.search', { query: '', limit: 10 })}
                        >
                          Preset: Invoices
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'odoo.finance.receivables.open', { limit: 20 })}
                        >
                          Preset: Receivables
                        </button>
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium"
                          onClick={() => setOperationPayload(tool.id, 'odoo.finance.payables.open', { limit: 20 })}
                        >
                          Preset: Payables
                        </button>
                      </div>
                    )}
                    <div className="rounded-lg bg-black/30 border border-white/10 p-3 space-y-2">
                      <div className="text-[11px] text-white/50 uppercase tracking-wide">Saved test scenarios</div>
                      {toolScenarios.length > 0 ? (
                        <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                          {toolScenarios.map((s) => (
                            <div key={s.id} className="text-[11px] text-white/75 rounded border border-white/10 bg-white/5 px-2 py-1.5 flex flex-wrap items-center gap-2">
                              <span className="font-medium">{s.name}</span>
                              <span className="text-white/45">{s.operation}</span>
                              {s.model_uuid ? <span className="text-white/35">· {displayModelLabel(models, s.model_uuid)}</span> : null}
                              <button className="glass-button px-2 py-0.5 rounded text-[10px]" onClick={() => setOperationPayload(tool.id, s.operation, parseJsonSafe(s.payload || '{}'))}>Load</button>
                              <button className="glass-button px-2 py-0.5 rounded text-[10px]" onClick={() => runSavedScenario(tool.id, s)}>Run</button>
                              <button className="glass-button px-2 py-0.5 rounded text-[10px]" onClick={() => openScenarioEditor(tool, s)}>Edit</button>
                              <button className="glass-button px-2 py-0.5 rounded text-[10px]" onClick={() => setSavedScenarios((prev) => prev.filter((x) => x.id !== s.id))}>Delete</button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-[11px] text-white/45">No saved scenarios yet. Use “Save Scenario” above to store the current operation and payload for this gateway.</div>
                      )}
                    </div>
                    {tool.kind === 'shopify_mcp' && shopifyDiagnosticsByToolId[tool.id] && (
                      <pre className="text-xs text-cyan-200/90 mt-1 whitespace-pre-wrap break-all max-h-52 overflow-y-auto rounded-lg bg-black/30 border border-cyan-500/20 p-3">
                        {JSON.stringify(shopifyDiagnosticsByToolId[tool.id], null, 2)}
                      </pre>
                    )}
                    {tool.kind === 'hubtiger' && (sampleBookingsByToolId[tool.id] || []).length > 0 && (
                      <div className="rounded-lg bg-black/30 border border-white/10 p-2 space-y-1">
                        <div className="text-[11px] text-white/50">Weekly sample customers (cross-store)</div>
                        {(sampleBookingsByToolId[tool.id] || []).slice(0, 3).map((s) => (
                          <div key={s.serviceID} className="text-[11px] text-white/70 flex flex-wrap items-center gap-2">
                            <span>{s.customerName} · {s.storeName || s.technicianName} · #{s.jobCardNo}</span>
                            <button className="glass-button px-2 py-0.5 rounded text-[10px]" onClick={() => fillFromSample(tool.id, s, 'job')}>Use job</button>
                            <button className="glass-button px-2 py-0.5 rounded text-[10px]" onClick={() => fillFromSample(tool.id, s, 'messages')}>Use messages</button>
                            <button className="glass-button px-2 py-0.5 rounded text-[10px]" onClick={() => fillFromSample(tool.id, s, 'note')}>Use note</button>
                          </div>
                        ))}
                      </div>
                    )}
                    <select
                      className="glass-input w-full px-3 py-2 rounded-lg text-sm bg-transparent"
                      value={executeOperationByToolId[tool.id] ?? (tool.kind === 'shopify_mcp' ? 'shopify.products.search' : tool.kind === 'odoo_rpc' ? 'odoo.current_user' : 'jobs_search')}
                      onChange={(e) => {
                        const op = e.target.value;
                        setExecuteOperationByToolId((prev) => ({ ...prev, [tool.id]: op }));
                        setExecutePayloadByToolId((prev) => ({ ...prev, [tool.id]: defaultPayloadForOperation(op) }));
                      }}
                    >
                      {(tool.kind === 'shopify_mcp' ? SHOPIFY_OPS : tool.kind === 'odoo_rpc' ? ODOO_OPS : HUB_OPS).map((op) => (
                        <option key={op} value={op} className="bg-slate-900">
                          {op}
                        </option>
                      ))}
                    </select>
                    <textarea
                      className="glass-input w-full px-3 py-2 rounded-lg text-xs font-mono min-h-28"
                      value={
                        executePayloadByToolId[tool.id] ??
                        defaultPayloadForOperation(executeOperationByToolId[tool.id] ?? (tool.kind === 'shopify_mcp' ? 'shopify.products.search' : tool.kind === 'odoo_rpc' ? 'odoo.current_user' : 'jobs_search'))
                      }
                      onChange={(e) =>
                        setExecutePayloadByToolId((prev) => ({ ...prev, [tool.id]: e.target.value }))
                      }
                    />
                    <button
                      className="glass-button px-3 py-2 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5"
                      disabled={executingId === tool.id}
                      onClick={() => onExecute(tool.id)}
                      title="Run execute operation"
                    >
                      {executingId === tool.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                      Execute
                    </button>
                  </div>
                  {executeResult !== null && executedToolId === tool.id && (
                    <div className="space-y-2 mt-3">
                      <div className="rounded-xl p-3 text-sm font-mono bg-black/30 border border-white/10 space-y-1">
                        <div className={executeResult.ok ? 'text-emerald-400' : 'text-red-400'}>
                          {executeResult.ok ? 'OK' : 'FAILED'} · {executeResult.latency_ms ?? 0}ms
                        </div>
                        {'trace_id' in executeResult && executeResult.trace_id ? (
                          <div className="text-white/50 text-xs truncate" title={String(executeResult.trace_id)}>
                            trace_id: {String(executeResult.trace_id)}
                          </div>
                        ) : null}
                        <div className="text-white/50 text-xs">
                          analysis model: {displayModelLabel(models, selectedModelForTool(tool.id))}
                        </div>
                        {executeResult.error ? (
                          <div className="text-red-300 text-xs">{String(executeResult.error)}</div>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="glass-button px-3 py-1.5 rounded-lg text-[11px] font-medium inline-flex items-center gap-1.5"
                          disabled={analysisLoadingId === tool.id}
                          onClick={() => void runAiReview(tool.id)}
                        >
                          {analysisLoadingId === tool.id ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                          Analyze with Model
                        </button>
                      </div>
                      {analysisByToolId[tool.id] ? (
                        <pre className="text-xs text-cyan-200/90 whitespace-pre-wrap break-all max-h-40 overflow-y-auto rounded-lg bg-black/30 border border-cyan-500/20 p-3">
                          {analysisByToolId[tool.id]}
                        </pre>
                      ) : null}
                      <pre className="text-xs text-white/60 whitespace-pre-wrap break-all max-h-52 overflow-y-auto rounded-lg bg-black/30 border border-white/10 p-3">
                        {JSON.stringify(executeResult, null, 2)}
                      </pre>
                    </div>
                  )}
                  {presetResultByToolId[tool.id] && (
                    <pre className="text-xs text-emerald-300/80 mt-2 whitespace-pre-wrap break-all max-h-52 overflow-y-auto rounded-lg bg-black/30 border border-emerald-500/20 p-3">
                      {JSON.stringify(presetResultByToolId[tool.id], null, 2)}
                    </pre>
                  )}
                  <div className="text-xs text-white/40 mt-2">
                    Sends <code className="text-white/60">{'{ operation, payload }'}</code> to{' '}
                    <code className="text-white/60">POST /api/tools/{tool.id}/execute</code>
                  </div>
                </div>
              )}
              <div className="glass-panel rounded-xl p-4 bg-black/20 border-white/5">
                <div className="flex items-center gap-2 text-sm text-white/70 mb-2">
                  <LinkIcon size={14} />
                  <span className="font-medium">Endpoint</span>
                </div>
                <code className="text-xs font-mono text-emerald-300/80 break-all">
                  POST /api/tools/{tool.id}/test
                </code>
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 text-sm">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-400" />
                  <span className="text-white/60">Server-side only</span>
                </div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-400" />
                  <span className="text-white/60">Trace + latency</span>
                </div>
              </div>
              {Object.keys(tool.config || {}).length > 0 && (
                <div className="glass-panel rounded-xl p-4 bg-black/20 border-white/5">
                  <div className="flex items-center gap-2 text-sm text-white/70 mb-2">
                    <Key size={14} />
                    <span className="font-medium">Config</span>
                  </div>
                  <code className="text-xs font-mono text-white/40 break-all">{JSON.stringify(tool.config)}</code>
                </div>
              )}
            </div>
          </div>
        )})}
          </div>
        </div>
      </div>
      {scenarioEditor.open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="glass-panel w-full max-w-2xl rounded-2xl p-5 border border-white/10 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-white/90">{scenarioEditor.scenarioId ? 'Edit Scenario' : 'Save Scenario'}</div>
                <div className="text-xs text-white/50">Persisted locally without page refresh.</div>
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
                value={scenarioEditor.model_uuid}
                onChange={(e) => setScenarioEditor((prev) => ({ ...prev, model_uuid: e.target.value }))}
              >
                <option value="">Auto (no model override)</option>
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
              <button className="glass-button-primary px-3 py-2 rounded-lg text-sm inline-flex items-center gap-2" onClick={saveScenarioEditor}>
                <Save size={14} />
                Save Scenario
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {loading && (
        <div className="glass-panel rounded-2xl p-8 flex items-center justify-center gap-2 text-white/60">
          <Loader2 size={20} className="animate-spin" />
          Loading tools…
        </div>
      )}
      {error && (
        <div className="glass-panel rounded-2xl p-4 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}
      {!loading && !error && visibleTools.length === 0 && (
        <div className="glass-panel rounded-2xl p-6 text-sm text-white/60 border border-white/10">
          No tools in this tab yet.
        </div>
      )}
    </motion.div>
  );
}
