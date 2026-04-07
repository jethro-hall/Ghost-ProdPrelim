import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { fetchCapabilities, fetchConnections } from "../api";
import type { AppOutletContext } from "../components/AppLayout";
import type { Connection, RuntimeCapabilities } from "../api";

function badgeClass(enabled: boolean) {
  return enabled ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-rose-50 text-rose-700 border-rose-200";
}

export default function ConnectionsPage() {
  const { openConnections } = useOutletContext<AppOutletContext>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null);

  async function refresh() {
    const [nextConnections, nextCapabilities] = await Promise.all([fetchConnections(), fetchCapabilities()]);
    setConnections(nextConnections);
    setCapabilities(nextCapabilities);
  }

  useEffect(() => {
    void refresh().catch(() => null);
  }, []);

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Connections</p>
            <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Provider runtime</h2>
            <p className="mt-2 max-w-[650px] text-[0.8rem] leading-6 text-slate-500">
              This page mirrors the designer’s infrastructure view while staying tied to the live provider records. Use it to confirm provider health before changing models, embeddings, or parse-lane behavior.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="ghost-btn" onClick={() => void refresh()}>
              Refresh
            </button>
            <button type="button" className="ghost-btn-primary" onClick={openConnections}>
              Manage providers
            </button>
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {connections.map((connection) => (
          <article key={connection.id} className="glass rounded-xl border border-slate-200 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[0.95rem] font-semibold text-slate-900">{connection.label}</h3>
                <p className="mt-1 text-[0.76rem] text-slate-500">{connection.base_url ?? "Using default provider base URL."}</p>
              </div>
              <span className={`rounded-full border px-2.5 py-1 text-[0.68rem] font-semibold ${badgeClass(connection.enabled && connection.has_api_key)}`}>
                {connection.enabled && connection.has_api_key ? "Connected" : "Disconnected"}
              </span>
            </div>

            <div className="mt-4 space-y-3 text-[0.8rem] text-slate-600">
              <div className="rounded-lg border border-slate-200 bg-white/80 p-3">
                <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-400">API Key</div>
                <div className="mt-1 font-mono text-[0.78rem] text-slate-900">{connection.api_key_hint ?? "Not configured"}</div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-200 bg-white/80 p-3">
                  <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-400">Chat Model</div>
                  <div className="mt-1 text-[0.78rem] text-slate-900">{connection.chat_model ?? "Default"}</div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-white/80 p-3">
                  <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-400">Embedding</div>
                  <div className="mt-1 text-[0.78rem] text-slate-900">{connection.embedding_model ?? "Default"}</div>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>

      <section className="glass rounded-xl border border-slate-200 p-5 text-[0.8rem] leading-6 text-slate-500">
        <span className="font-semibold text-slate-900">Cloud lane readiness:</span>{" "}
        {capabilities?.parser_lanes.cloud.message ?? "Loading parser lane capability state..."}
      </section>
    </div>
  );
}
