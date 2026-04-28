import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { fetchCapabilities, fetchConnections } from "../api";
import { CONNECTIONS_UPDATED_EVENT } from "../components/AppLayout";
import type { AppOutletContext } from "../components/AppLayout";
import type { Connection, RuntimeCapabilities } from "../api";

function badgeClass(enabled: boolean) {
  return enabled ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200";
}

export default function ConnectionsPage() {
  const { openConnections } = useOutletContext<AppOutletContext>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null);

  const refresh = useCallback(async () => {
    const [nextConnections, nextCapabilities] = await Promise.all([fetchConnections(), fetchCapabilities()]);
    setConnections(nextConnections);
    setCapabilities(nextCapabilities);
  }, []);

  useEffect(() => {
    void refresh().catch(() => null);
    const handleConnectionsUpdated = () => {
      void refresh().catch(() => null);
    };
    window.addEventListener(CONNECTIONS_UPDATED_EVENT, handleConnectionsUpdated);
    return () => window.removeEventListener(CONNECTIONS_UPDATED_EVENT, handleConnectionsUpdated);
  }, [refresh]);

  return (
    <div className="connections-page space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Connections</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-[1rem] font-semibold text-slate-900">Provider runtime</h2>
              <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
                {connections.length} records
              </span>
            </div>
          </div>
          <div className="connections-command-bar flex items-center gap-2">
            <button type="button" className="ghost-btn" onClick={() => void refresh()}>
              Refresh
            </button>
            <button type="button" className="ghost-btn-primary" onClick={openConnections}>
              Manage providers
            </button>
          </div>
        </div>
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,1fr)_330px]">
        <section className="grid gap-3 lg:grid-cols-2">
          {connections.map((connection) => (
            <article key={connection.id} className="glass rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-[0.9rem] font-semibold text-slate-900">{connection.label}</h3>
                  <p className="mt-1 truncate text-[0.72rem] text-slate-500">{connection.base_url ?? "Using default provider base URL."}</p>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] ${badgeClass(connection.enabled && connection.has_api_key)}`}>
                  {connection.enabled && connection.has_api_key ? "Connected" : "Disconnected"}
                </span>
              </div>

              <div className="mt-3 grid gap-2 text-[0.72rem] text-slate-600">
                <div className="rounded-lg border border-slate-200 bg-white/80 p-2">
                  <div className="text-[0.62rem] font-bold uppercase tracking-[0.14em] text-slate-400">API key</div>
                  <div className="mt-1 font-mono text-[0.72rem] text-slate-900">{connection.api_key_hint ?? "Not configured"}</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white/80 p-2">
                  <div className="text-[0.62rem] font-bold uppercase tracking-[0.14em] text-slate-400">Provider kind</div>
                  <div className="mt-1 text-[0.72rem] text-slate-900">{connection.provider_kind}</div>
                  <div className="mt-1 text-[0.68rem] text-slate-500">
                    Auth: {connection.auth_strategy}
                    {connection.auth_header_name ? ` (${connection.auth_header_name})` : ""}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </section>

        <aside className="glass rounded-xl border border-slate-200 p-3">
          <div className="space-y-3">
            <section className="rounded-lg border border-slate-200 bg-white/80 p-2 text-[0.72rem] text-slate-600">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Ownership</div>
              <div>Transport, credentials, and base URL only.</div>
              <div className="mt-1 text-slate-500">
                LLM model, embedding model, and retrieval defaults live in runtime profiles so there is one canonical owner.
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white/80 p-2 text-[0.72rem] text-slate-600">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Cloud lane readiness</div>
              <div>{capabilities?.parser_lanes.cloud.message ?? "Loading parser lane capability state..."}</div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
