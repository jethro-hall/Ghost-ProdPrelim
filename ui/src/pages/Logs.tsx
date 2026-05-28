import { useEffect, useState } from "react";
import { fetchRuns } from "../api";
import type { RunSummary } from "../api";

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

function statusClass(status: string) {
  if (status === "completed") return "text-emerald-600";
  if (status === "failed") return "text-rose-600";
  if (status === "running") return "text-amber-600";
  return "text-slate-500";
}

function statusBadgeClass(status: string) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "running") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-100 text-slate-600";
}

export default function Logs() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refreshRuns() {
    setLoading(true);
    setError(null);
    try {
      setRuns(await fetchRuns());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshRuns();
  }, []);

  return (
    <div className="logs-page space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Operational trace</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-[1rem] font-semibold text-slate-900">Recent ingestion runs</h2>
              <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
                {loading ? "Loading" : `${runs.length} runs`}
              </span>
            </div>
          </div>
          <div className="logs-command-bar flex items-center gap-2">
            <button type="button" className="ghost-btn" onClick={() => void refreshRuns()}>
              Refresh
            </button>
          </div>
        </div>
        {error && (
          <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[0.74rem] text-rose-700">
            {error}
          </div>
        )}
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px] 2xl:grid-cols-[minmax(0,1fr)_350px]">
        <section className="glass rounded-xl border border-slate-200 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-[0.84rem] font-semibold text-slate-900">Run stream</h3>
            <div className="text-[0.7rem] text-slate-500">Queue, progress, and failure evidence</div>
          </div>

          <div className="space-y-2">
            {loading && <p className="text-[0.74rem] text-slate-500">Loading recent runs...</p>}
            {!loading && !error && runs.length === 0 && (
              <p className="text-[0.74rem] text-slate-500">No recent ingestion runs found.</p>
            )}
            {!loading && !error && runs.map((run) => (
              <div key={run.id} className="rounded-lg border border-slate-200 bg-white/85 p-3 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[0.78rem] font-semibold text-slate-900">
                      {run.run_type.replaceAll("_", " ")} • {run.corpus}
                    </div>
                    <div className="mt-1 text-[0.7rem] text-slate-500">
                      {formatTimestamp(run.created_at)} • {run.current_step.replaceAll("_", " ")}
                    </div>
                  </div>
                  <div className={`rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] ${statusBadgeClass(run.status)}`}>
                    {run.status}
                  </div>
                </div>
                <div className={`mt-2 text-[0.7rem] ${statusClass(run.status)}`}>Progress: {Math.round(run.progress * 100)}%</div>
                {run.error_message && <div className="mt-1 text-[0.7rem] text-rose-600">{run.error_message}</div>}
                {Object.keys(run.result_json || {}).length > 0 && (
                  <pre className="ghost-scroll mt-2 max-h-[220px] overflow-auto rounded-lg bg-slate-950 px-3 py-2 text-[0.68rem] text-slate-100">
                    {JSON.stringify(run.result_json, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </section>

        <aside className="glass rounded-xl border border-slate-200 p-3">
          <div className="space-y-3">
            <section className="rounded-lg border border-slate-200 bg-white/80 p-2">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Live stack</div>
              <div className="text-[0.72rem] leading-5 text-slate-600">
                Control API, workflow runtime, agent ingress, UI, Qdrant, Postgres, and Caddy are running in the `ghoststack-rag` compose stack.
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white/80 p-2">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Trace correlation</div>
              <div className="text-[0.72rem] leading-5 text-slate-600">
                API responses carry `X-Trace-Id`, sync triggers preserve trace propagation, and ingestion runs expose result summaries here for quick comparison.
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white/80 p-2">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Verify commands</div>
              <pre className="ghost-scroll overflow-auto rounded-lg bg-slate-950 px-3 py-2 text-[0.66rem] text-slate-100">{`docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-workflow-runtime-1
curl -s https://ghoststack.rideai.com.au/api/runs | jq`}</pre>
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
