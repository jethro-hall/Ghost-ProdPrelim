import { useEffect, useMemo, useState } from "react";

import {
  fetchHubTigerStatus,
  fetchHubTigerTraces,
  runHubTigerTest,
  type HubTigerBinding,
  type HubTigerStatusPayload,
  type HubTigerTestOperation,
  type HubTigerTestPayload,
  type HubTigerTrace,
} from "../api";

const HUBTIGER_WRITE_OPERATIONS: HubTigerTestOperation[] = [
  "booking_create",
  "booking_submit",
  "booking_finalize",
  "booking_customer_confirm",
  "booking_bike_confirm",
  "booking_update",
  "quote_add_line_item",
];

const EMPTY_STATUS: HubTigerStatusPayload = {
  status: {
    mode: "read_only",
    mcp_url_configured: false,
    proxy_url_configured: false,
    read_timeout_ms: 8000,
    mutation_timeout_ms: 12000,
    health: "unconfigured",
    message: "Loading HubTiger status...",
  },
  bindings: [],
};

export default function ToolsPage() {
  const [statusPayload, setStatusPayload] = useState<HubTigerStatusPayload>(EMPTY_STATUS);
  const [traces, setTraces] = useState<HubTigerTrace[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<HubTigerTestPayload | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [operation, setOperation] = useState<HubTigerTestOperation>("availability_lookup");
  const [payloadText, setPayloadText] = useState('{"postcode":"4220"}');

  async function refresh() {
    setIsLoading(true);
    setTestError(null);
    try {
      const [status, recentTraces] = await Promise.all([fetchHubTigerStatus(), fetchHubTigerTraces(15)]);
      setStatusPayload(status);
      setTraces(recentTraces);
    } catch {
      setTestError("HubTiger admin console is unavailable right now.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const groupedBindings = useMemo(() => {
    const groups: Record<string, HubTigerBinding[]> = {};
    for (const binding of statusPayload.bindings) {
      if (!groups[binding.category]) groups[binding.category] = [];
      groups[binding.category].push(binding);
    }
    return groups;
  }, [statusPayload.bindings]);

  const writeDisabled =
    statusPayload.status.mode === "read_only" && HUBTIGER_WRITE_OPERATIONS.includes(operation);

  async function handleRunTest() {
    setTestError(null);
    setTestResult(null);
    let parsedPayload: Record<string, unknown> = {};
    try {
      parsedPayload = payloadText.trim() ? (JSON.parse(payloadText) as Record<string, unknown>) : {};
    } catch {
      setTestError("Payload must be valid JSON.");
      return;
    }
    setTestBusy(true);
    try {
      const result = await runHubTigerTest({ operation, payload: parsedPayload });
      setTestResult(result);
      const recentTraces = await fetchHubTigerTraces(15);
      setTraces(recentTraces);
    } catch {
      setTestError("HubTiger test could not run.");
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <div className="tools-page space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-4">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">HubTiger Tools</p>
        <h2 className="mt-1 text-[1rem] font-semibold text-slate-900">Connection and permissions</h2>
        <p className="mt-2 text-[0.82rem] text-slate-600">{statusPayload.status.message}</p>
        <div className="mt-3 grid gap-2 text-[0.74rem] text-slate-700 md:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white/80 p-2">
            Mode: <span className="font-semibold">{statusPayload.status.mode}</span>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white/80 p-2">
            Health: <span className="font-semibold">{statusPayload.status.health}</span>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white/80 p-2">
            MCP configured: <span className="font-semibold">{statusPayload.status.mcp_url_configured ? "yes" : "no"}</span>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white/80 p-2">
            Proxy configured: <span className="font-semibold">{statusPayload.status.proxy_url_configured ? "yes" : "no"}</span>
          </div>
        </div>
      </section>

      <section className="glass rounded-xl border border-slate-200 px-4 py-4">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Tool Matrix</p>
        <h3 className="mt-1 text-[0.95rem] font-semibold text-slate-900">Category and mode matrix</h3>
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white/80">
          <table className="min-w-full text-left text-[0.74rem]">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Tool</th>
                <th className="px-3 py-2 font-semibold">Category</th>
                <th className="px-3 py-2 font-semibold">Mode</th>
                <th className="px-3 py-2 font-semibold">Write action</th>
              </tr>
            </thead>
            <tbody>
              {statusPayload.bindings.map((binding) => (
                <tr key={binding.tool_id} className="border-b border-slate-100 text-slate-700 last:border-b-0">
                  <td className="px-3 py-2">{binding.label}</td>
                  <td className="px-3 py-2">{binding.category}</td>
                  <td className="px-3 py-2">{binding.mode}</td>
                  <td className="px-3 py-2">{binding.write_action ? "yes" : "no"}</td>
                </tr>
              ))}
              {statusPayload.bindings.length === 0 && (
                <tr>
                  <td className="px-3 py-3 text-slate-500" colSpan={4}>
                    {isLoading ? "Loading bindings..." : "No HubTiger bindings available."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="glass rounded-xl border border-slate-200 px-4 py-4">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Test Console</p>
        <h3 className="mt-1 text-[0.95rem] font-semibold text-slate-900">Safe HubTiger operation test</h3>
        <p className="mt-1 text-[0.72rem] text-slate-500">
          For step-by-step booking simulation, use <span className="font-semibold">Agent test</span> in the header or the chat bubble (bottom-right).
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <label className="text-[0.74rem] text-slate-600">
            Operation
            <select
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-[0.78rem]"
              value={operation}
              onChange={(event) => setOperation(event.target.value as HubTigerTestOperation)}
            >
              <optgroup label="Read">
                <option value="availability_lookup">availability_lookup</option>
                <option value="job_lookup">job_lookup</option>
                <option value="job_search">job_search</option>
                <option value="job_retrieve">job_retrieve</option>
                <option value="quote_preview">quote_preview</option>
                <option value="booking_slot_hold">booking_slot_hold</option>
                <option value="booking_customer_search">booking_customer_search</option>
                <option value="booking_bike_list">booking_bike_list</option>
                <option value="booking_service_set">booking_service_set</option>
              </optgroup>
              <optgroup label="Write (guarded)">
                <option value="booking_customer_confirm">booking_customer_confirm</option>
                <option value="booking_bike_confirm">booking_bike_confirm</option>
                <option value="booking_submit">booking_submit</option>
                <option value="booking_finalize">booking_finalize</option>
                <option value="booking_create">booking_create</option>
                <option value="booking_update">booking_update</option>
                <option value="quote_add_line_item">quote_add_line_item</option>
              </optgroup>
            </select>
          </label>
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[0.72rem] text-slate-600">
            Write operations are blocked when mode is <code>read_only</code>.
          </div>
        </div>
        <label className="mt-2 block text-[0.74rem] text-slate-600">
          Payload JSON
          <textarea
            className="mt-1 h-28 w-full rounded-md border border-slate-300 bg-white px-2 py-2 font-mono text-[0.72rem]"
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
          />
        </label>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className="rounded-md bg-slate-900 px-3 py-2 text-[0.74rem] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void handleRunTest()}
            disabled={testBusy || writeDisabled}
          >
            {testBusy ? "Running..." : "Run test"}
          </button>
          <button type="button" className="rounded-md border border-slate-300 px-3 py-2 text-[0.74rem] text-slate-700" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        {writeDisabled && (
          <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[0.72rem] text-amber-700">
            This operation is disabled in read-only mode.
          </div>
        )}
        {testError && <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[0.72rem] text-rose-700">{testError}</div>}
        {testResult && (
          <div className="mt-2 rounded-md border border-slate-200 bg-white px-2 py-2 text-[0.72rem] text-slate-700">
            <div className="font-semibold">{testResult.message}</div>
            <div className="mt-1">
              mode: {testResult.mode} • success: {String(testResult.success)} • blocked: {String(testResult.blocked)} • trace:{" "}
              {testResult.trace_id ?? "n/a"}
            </div>
          </div>
        )}
      </section>

      <section className="glass rounded-xl border border-slate-200 px-4 py-4">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Recent Safe Traces</p>
        <div className="mt-2 space-y-2">
          {traces.map((trace) => (
            <div key={trace.trace_id} className="rounded-md border border-slate-200 bg-white/80 px-2 py-2 text-[0.72rem] text-slate-700">
              <div className="font-semibold">{trace.operation}</div>
              <div>
                {trace.summary} • mode={trace.mode} • success={String(trace.success)} • blocked={String(trace.blocked)}
              </div>
              <div className="text-slate-500">{trace.created_at}</div>
            </div>
          ))}
          {traces.length === 0 && <div className="rounded-md border border-slate-200 bg-white/80 px-2 py-2 text-[0.72rem] text-slate-500">No traces yet.</div>}
        </div>
      </section>

      {Object.keys(groupedBindings).length > 0 && (
        <section className="glass rounded-xl border border-slate-200 px-4 py-4">
          <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Category Groups</p>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {Object.entries(groupedBindings).map(([category, entries]) => (
              <div key={category} className="rounded-md border border-slate-200 bg-white/80 px-2 py-2 text-[0.72rem] text-slate-700">
                <div className="font-semibold">{category}</div>
                <div className="mt-1">{entries.map((entry) => entry.tool_id).join(", ")}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="glass rounded-xl border border-slate-200 px-4 py-4">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Legacy Odoo</p>
        <p className="mt-2 text-[0.82rem] text-slate-600">
          Direct operator access to the legacy <code>odoo_primary</code> tool surface remains retired. Finance retrieval stays on MAS v2.
        </p>
      </section>
    </div>
  );
}
