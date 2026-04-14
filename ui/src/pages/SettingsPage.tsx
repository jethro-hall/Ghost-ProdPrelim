import { useMemo } from "react";

export default function SettingsPage() {
  const redisConfigured = false;
  const cacheStrategy = useMemo(() => "Native-first embedding cache planned", []);

  return (
    <div className="settings-page space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">System administration</p>
            <h2 className="mt-1 text-[1rem] font-semibold text-slate-900">Cache and infrastructure</h2>
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.14em] ${redisConfigured ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
            {redisConfigured ? "Connected" : "Not configured"}
          </span>
        </div>
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="glass rounded-xl border border-slate-200 p-4">
          <div className="text-[0.84rem] font-semibold text-slate-900">Redis infrastructure</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3 text-[0.74rem] text-slate-500">
            <div className="rounded-xl border border-slate-200 bg-white/80 p-3">Host: not present</div>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-3">Port: n/a</div>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-3">Reason: current stack uses Postgres + Qdrant only.</div>
          </div>
        </section>

        <aside className="glass rounded-xl border border-slate-200 p-3">
          <div className="rounded-lg border border-slate-200 bg-white/80 p-3 text-[0.72rem] text-slate-500">
            <div className="font-semibold text-slate-900">Caching strategy</div>
            <div className="mt-1">{cacheStrategy}</div>
            <div className="mt-2">Start at the shared embedding choke point, then decide whether Redis is still needed once hit rates and sharing requirements are visible.</div>
          </div>
        </aside>
      </div>
    </div>
  );
}
