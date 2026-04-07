import { useMemo } from "react";

export default function SettingsPage() {
  const redisConfigured = false;
  const cacheStrategy = useMemo(() => "Native-first embedding cache planned", []);

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">System Administration</p>
        <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Cache & infrastructure</h2>
        <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
          The designer handover specifies Redis-backed LLM caching. The current live stack does not run Redis, so this page starts by exposing the gap honestly while the native-first caching implementation is added.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <article className="glass rounded-xl border border-slate-200 p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[0.88rem] font-semibold text-slate-900">Redis infrastructure</h3>
            <span className={`rounded-full border px-2.5 py-1 text-[0.68rem] font-semibold ${redisConfigured ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
              {redisConfigured ? "Connected" : "Not configured"}
            </span>
          </div>
          <div className="mt-4 space-y-3 text-[0.78rem] text-slate-500">
            <div className="rounded-xl border border-slate-200 bg-white/80 p-3">Host: not present in current compose stack</div>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-3">Port: n/a</div>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-3">Reason: current system uses Postgres + Qdrant and no Redis service has been provisioned.</div>
          </div>
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5">
          <h3 className="text-[0.88rem] font-semibold text-slate-900">Caching strategy</h3>
          <div className="mt-4 rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.78rem] text-slate-500">
            <div className="font-semibold text-slate-900">Planned direction</div>
            <div className="mt-1">{cacheStrategy}</div>
            <div className="mt-3">Start at the shared embedding choke point, then decide whether Redis is still needed once hit rates and sharing requirements are visible.</div>
          </div>
        </article>
      </div>
    </div>
  );
}
