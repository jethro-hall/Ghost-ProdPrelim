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
    <div className="max-w-[760px] space-y-4">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Logs</p>
        <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Operational trace view</h2>
        <p className="mt-2 text-[0.82rem] leading-6 text-slate-500">
          The stack emits structured JSON logs with trace IDs for inbound requests and outbound calls. This page now also surfaces recent ingestion runs so operators can correlate queue state, progress, and failure reasons quickly.
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <article className="glass rounded-xl border border-slate-200 p-4">
          <h3 className="text-[0.85rem] font-semibold text-slate-900">Live stack</h3>
          <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
            Control API, workflow runtime, agent ingress, UI, Qdrant, Postgres, and Caddy are running in the `ghoststack-rag` compose stack.
          </p>
        </article>
        <article className="glass rounded-xl border border-slate-200 p-4">
          <h3 className="text-[0.85rem] font-semibold text-slate-900">Trace correlation</h3>
          <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
            Each API response includes `X-Trace-Id`, sync queue triggers preserve trace propagation to the workflow runtime, and ingestion runs can now be reviewed alongside status and result summaries.
          </p>
        </article>
      </section>

      <section className="glass rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-3">
          <div>
            <h3 className="text-[0.85rem] font-semibold text-slate-900">Recent ingestion runs</h3>
            <p className="mt-1 text-[0.78rem] text-slate-500">Latest queue and import activity from the control API.</p>
          </div>
          <button type="button" className="ghost-btn" onClick={() => void refreshRuns()}>
            Refresh
          </button>
        </div>

        <div className="mt-3 space-y-2">
          {loading && <p className="text-[0.78rem] text-slate-500">Loading recent runs...</p>}
          {error && <p className="text-[0.78rem] text-rose-600">{error}</p>}
          {!loading && !error && runs.length === 0 && (
            <p className="text-[0.78rem] text-slate-500">No recent ingestion runs found.</p>
          )}
          {!loading && !error && runs.map((run) => (
            <div key={run.id} className="rounded-lg border border-slate-200 bg-white/85 p-3 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[0.8rem] font-semibold text-slate-900">
                    {run.run_type.replaceAll("_", " ")} • {run.corpus}
                  </div>
                  <div className="mt-1 text-[0.72rem] text-slate-500">
                    {formatTimestamp(run.created_at)} • step: {run.current_step.replaceAll("_", " ")}
                  </div>
                </div>
                <div className={`text-[0.78rem] font-semibold ${statusClass(run.status)}`}>{run.status}</div>
              </div>
              <div className="mt-2 text-[0.74rem] text-slate-500">Progress: {Math.round(run.progress * 100)}%</div>
              {run.error_message && <div className="mt-1 text-[0.74rem] text-rose-600">{run.error_message}</div>}
              {Object.keys(run.result_json || {}).length > 0 && (
                <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-950 px-3 py-2 text-[0.7rem] text-slate-100">
                  {JSON.stringify(run.result_json, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="glass rounded-xl border border-slate-200 p-4">
        <h3 className="text-[0.85rem] font-semibold text-slate-900">Useful verify commands</h3>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-950 px-4 py-3 text-[0.74rem] text-slate-100">{`docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-workflow-runtime-1
curl -s https://ghoststack.rideai.com.au/api/runs | jq`}</pre>
      </section>
    </div>
  );
}
