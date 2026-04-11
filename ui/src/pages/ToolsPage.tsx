import { useEffect, useMemo, useState } from "react";
import {
  executeTool,
  fetchToolDetail,
  saveToolSettings,
  setToolActivation,
  testTool,
} from "../api";
import type { ToolDetail, ToolExecuteResult, ToolTestResult } from "../api";

const TOOL_ID = "odoo_primary";

const OPERATION_TEMPLATES: Record<string, Record<string, unknown>> = {
  "odoo.meta.current_user": {},
  "odoo.products.search_read": { limit: 10, query: "" },
  "odoo.customers.search_read": { limit: 10, query: "" },
  "odoo.sales.orders.search_read": { limit: 10, state: "" },
  "odoo.finance.invoices.search_read": { limit: 10, payment_state: "" },
  "odoo.finance.receivables.open": { limit: 10, due_before: "" },
};

function healthBadge(status: string) {
  if (status === "healthy") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "unhealthy") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function resultBadge(success: boolean) {
  return success ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700";
}

function stringifyPayload(value: Record<string, unknown>) {
  return JSON.stringify(value, null, 2);
}

type Evidence<T> = {
  capturedAt: string;
  result: T;
};

export default function ToolsPage() {
  const [detail, setDetail] = useState<ToolDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(20_000);
  const [selectedOperation, setSelectedOperation] = useState("odoo.meta.current_user");
  const [payloadText, setPayloadText] = useState(stringifyPayload(OPERATION_TEMPLATES["odoo.meta.current_user"]));
  const [testEvidence, setTestEvidence] = useState<Evidence<ToolTestResult> | null>(null);
  const [executeEvidence, setExecuteEvidence] = useState<Evidence<ToolExecuteResult> | null>(null);

  async function load() {
    setLoading(true);
    setPageError(null);
    try {
      const nextDetail = await fetchToolDetail(TOOL_ID);
      setDetail(nextDetail);
      setBaseUrl(nextDetail.settings.base_url ?? "");
      setDatabase(nextDetail.settings.database ?? "");
      setUsername("");
      setPassword("");
      setTimeoutMs(nextDetail.settings.timeout_ms);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setPayloadText(stringifyPayload(OPERATION_TEMPLATES[selectedOperation] ?? {}));
  }, [selectedOperation]);

  const missingConfigText = useMemo(() => {
    if (!detail?.settings.missing_config.length) return "Configuration complete.";
    return `Missing: ${detail.settings.missing_config.join(", ")}`;
  }, [detail]);

  async function handleSave() {
    setSaving(true);
    setPageError(null);
    setSaveMessage(null);
    try {
      const saved = await saveToolSettings(TOOL_ID, {
        base_url: baseUrl.trim() || null,
        database: database.trim() || null,
        username: username.trim() || null,
        password: password.trim() || null,
        timeout_ms: timeoutMs,
      });
      setDetail(saved);
      setPassword("");
      setUsername("");
      setSaveMessage("Odoo settings saved to GhostDASH.");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setPageError(null);
    try {
      const result = await testTool(TOOL_ID);
      setTestEvidence({ capturedAt: new Date().toISOString(), result });
      await load();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  async function handleActivation(nextActive: boolean) {
    setPageError(null);
    try {
      await setToolActivation(TOOL_ID, nextActive);
      await load();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleExecute() {
    setRunning(true);
    setPageError(null);
    try {
      const parsed = payloadText.trim() ? (JSON.parse(payloadText) as Record<string, unknown>) : {};
      const result = await executeTool(TOOL_ID, { operation: selectedOperation, payload: parsed });
      setExecuteEvidence({ capturedAt: new Date().toISOString(), result });
      await load();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Tool Settings & API Testing</p>
            <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Odoo read-only gateway</h2>
            <p className="mt-2 max-w-[760px] text-[0.8rem] leading-6 text-slate-500">
              Configure the live Odoo connection, prove the health path, and run only the approved read-only operations from the handover contract. Activation here controls whether agents may use the tool at runtime after their own policy also allows it.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="ghost-btn" onClick={() => void load()}>
              Refresh
            </button>
            <button
              type="button"
              className="ghost-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleSave()}
              disabled={saving || loading}
            >
              {saving ? "Saving..." : "Save settings"}
            </button>
          </div>
        </div>
        {pageError && <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[0.78rem] text-rose-700">{pageError}</div>}
        {saveMessage && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[0.78rem] text-emerald-700">{saveMessage}</div>}
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[0.92rem] font-semibold text-slate-900">Connection settings</h3>
            {detail && (
              <span className={`rounded-full border px-2.5 py-1 text-[0.68rem] font-semibold ${healthBadge(detail.status)}`}>
                {detail.status}
              </span>
            )}
          </div>
          <label className="block text-[0.76rem] text-slate-500">
            Odoo base URL
            <input className="ghost-input mt-1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://odoo.example.com" />
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-[0.76rem] text-slate-500">
              Database
              <input className="ghost-input mt-1" value={database} onChange={(event) => setDatabase(event.target.value)} />
            </label>
            <label className="block text-[0.76rem] text-slate-500">
              Timeout (ms)
              <input
                className="ghost-input mt-1"
                type="number"
                min="1000"
                max="120000"
                step="1000"
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(Number(event.target.value))}
              />
            </label>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-[0.76rem] text-slate-500">
              Username
              <input
                className="ghost-input mt-1"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder={detail?.settings.username_hint ?? "Enter username"}
              />
              <span className="mt-1 block text-[0.68rem] text-slate-400">
                Leave blank to keep the currently stored identity.
              </span>
            </label>
            <label className="block text-[0.76rem] text-slate-500">
              Password
              <input
                className="ghost-input mt-1"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={detail?.settings.has_password ? "Stored password present" : "Enter password"}
              />
              <span className="mt-1 block text-[0.68rem] text-slate-400">
                Leave blank to keep the stored secret.
              </span>
            </label>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.76rem] text-slate-500">
            <div className="font-semibold text-slate-900">Runtime surface</div>
            <div className="mt-2">Health endpoint: {detail?.settings.health_path ?? "/api/tools/odoo_primary/test"}</div>
            <div className="mt-1">Execute endpoint: {detail?.settings.execute_path ?? "/api/tools/odoo_primary/execute"}</div>
            <div className="mt-1">Safe operations: {(detail?.safe_operations ?? []).join(", ") || "Loading..."}</div>
            <div className="mt-1">{missingConfigText}</div>
          </div>
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[0.92rem] font-semibold text-slate-900">Readiness & activation</h3>
            {detail && (
              <span
                className={`rounded-full border px-2.5 py-1 text-[0.68rem] font-semibold ${
                  detail.active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-100 text-slate-600"
                }`}
              >
                {detail.active ? "Globally active" : "Globally inactive"}
              </span>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="ghost-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleTest()}
              disabled={testing || loading}
            >
              {testing ? "Testing..." : "Run health test"}
            </button>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void handleActivation(!(detail?.active ?? false))}
              disabled={loading}
            >
              {detail?.active ? "Deactivate tool" : "Activate tool"}
            </button>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.76rem] text-slate-500">
            <div className="font-semibold text-slate-900">Operator notes</div>
            <div className="mt-2">Global activation is only one gate. The selected agent must also allow Odoo in Agent Config, and ChatUI can still turn it off per session.</div>
          </div>
          {testEvidence && (
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.76rem] text-slate-600">
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-slate-900">Latest health evidence</div>
                <span className={`rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold ${resultBadge(testEvidence.result.success)}`}>
                  {testEvidence.result.success ? "Passed" : "Failed"}
                </span>
              </div>
              <div className="mt-2">Captured at: {testEvidence.capturedAt}</div>
              <div className="mt-1">Trace id: {testEvidence.result.trace_id ?? "n/a"}</div>
              <div className="mt-1">Latency: {testEvidence.result.latency_ms ?? "n/a"} ms</div>
              <div className="mt-1">Message: {testEvidence.result.message}</div>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-slate-950 p-3 text-[0.7rem] text-slate-100">
                {JSON.stringify(testEvidence.result.data, null, 2)}
              </pre>
            </div>
          )}
        </article>
      </div>

      <section className="glass rounded-xl border border-slate-200 p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[0.92rem] font-semibold text-slate-900">Approved read-only operations</h3>
            <p className="mt-1 text-[0.78rem] leading-6 text-slate-500">
              Execute the frozen initial Odoo surface and keep the returned trace, latency, and payload as evidence for rollout validation.
            </p>
          </div>
          <button
            type="button"
            className="ghost-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleExecute()}
            disabled={running || loading}
          >
            {running ? "Running..." : "Execute"}
          </button>
        </div>
        <div className="grid gap-4 xl:grid-cols-[0.55fr_0.45fr]">
          <div className="space-y-4">
            <label className="block text-[0.76rem] text-slate-500">
              Operation
              <select className="ghost-select mt-1" value={selectedOperation} onChange={(event) => setSelectedOperation(event.target.value)}>
                {(detail?.safe_operations ?? Object.keys(OPERATION_TEMPLATES)).map((operation) => (
                  <option key={operation} value={operation}>
                    {operation}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[0.76rem] text-slate-500">
              JSON payload
              <textarea className="ghost-textarea mt-1 min-h-[260px] font-mono text-[0.74rem]" value={payloadText} onChange={(event) => setPayloadText(event.target.value)} />
            </label>
          </div>
          <div>
            {executeEvidence ? (
              <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.76rem] text-slate-600">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-semibold text-slate-900">Latest execution evidence</div>
                  <span className={`rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold ${resultBadge(executeEvidence.result.success)}`}>
                    {executeEvidence.result.success ? "Passed" : "Failed"}
                  </span>
                </div>
                <div className="mt-2">Captured at: {executeEvidence.capturedAt}</div>
                <div className="mt-1">Trace id: {executeEvidence.result.trace_id ?? "n/a"}</div>
                <div className="mt-1">Latency: {executeEvidence.result.latency_ms ?? "n/a"} ms</div>
                <div className="mt-1">Operation: {executeEvidence.result.operation ?? selectedOperation}</div>
                <div className="mt-1">Message: {executeEvidence.result.message}</div>
                <pre className="mt-3 max-h-[360px] overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-3 text-[0.7rem] text-slate-100">
                  {JSON.stringify(executeEvidence.result.data, null, 2)}
                </pre>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white/70 p-6 text-[0.78rem] text-slate-500">
                No operation evidence captured yet. Pick one of the approved operations and execute it to record a traceable result here.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
