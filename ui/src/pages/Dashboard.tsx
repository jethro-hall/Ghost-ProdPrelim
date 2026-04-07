import { useEffect, useMemo, useState } from "react";
import GhostCard from "../components/GhostCard";
import { fetchCapabilities, fetchConnections, fetchDocuments, fetchRuns, fetchRuntimeDefaults, fetchVectorStats } from "../api";
import type { Connection, DocumentIngestion, RunSummary, RuntimeCapabilities, RuntimeDefaults, VectorStats } from "../api";

function statusTone(status: string) {
  if (status === "completed") return "text-emerald-600";
  if (status === "failed") return "text-rose-600";
  if (status === "running") return "text-amber-600";
  return "text-slate-500";
}

function badgeTone(status: string) {
  if (status === "completed" || status === "indexed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "failed" || status === "error") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "running") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-100 text-slate-600";
}

function formatApiMode(mode: string | undefined) {
  if (!mode) return "Loading";
  return mode === "chat_completions" ? "Chat Completions" : "Responses";
}

function summarizeChatModes(capabilities: RuntimeCapabilities | null) {
  if (!capabilities) return "Loading API mode readiness...";
  const modes = Object.entries(capabilities.chat_api_modes)
    .filter(([, value]) => value.available)
    .map(([key]) => (key === "chat_completions" ? "Chat Completions" : "Responses"));
  return modes.length > 0 ? modes.join(" + ") : "Unavailable";
}

export default function Dashboard() {
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [runtimeDefaults, setRuntimeDefaults] = useState<RuntimeDefaults | null>(null);
  const [vectorStats, setVectorStats] = useState<VectorStats | null>(null);
  const [documents, setDocuments] = useState<DocumentIngestion[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    void fetchCapabilities().then(setCapabilities).catch(() => null);
    void fetchConnections().then(setConnections).catch(() => null);
    void fetchRuntimeDefaults().then(setRuntimeDefaults).catch(() => null);
    void fetchVectorStats().then(setVectorStats).catch(() => null);
    void fetchDocuments().then(setDocuments).catch(() => null);
    void fetchRuns().then(setRuns).catch(() => null);
  }, []);

  const cloudReady = capabilities?.parser_lanes.cloud.available ?? false;
  const streamingReady = capabilities?.streaming.available ?? false;
  const activeConnection = useMemo(() => connections.find((connection) => connection.enabled) ?? connections[0] ?? null, [connections]);
  const recentDocuments = useMemo(() => documents.slice(0, 6), [documents]);

  const cards = useMemo(
    () => [
      {
        label: "LOCAL LANE",
        title: capabilities?.parser_lanes.local.available ? "Ready" : "Unavailable",
        description:
          capabilities?.parser_lanes.local.message ??
          "Deterministic local parsers are ready, including table-first workbook ingestion.",
      },
      {
        label: "CLOUD LANE",
        title: cloudReady ? "Ready" : "Blocked",
        description:
          capabilities?.parser_lanes.cloud.message ??
          "Cloud parsing enrichment is unavailable until the Llama Cloud key is configured.",
        labelColor: "var(--color-warning)",
        titleColor: "var(--color-warning)",
        borderColor: "rgba(245, 158, 11, 0.5)",
      },
      {
        label: "CHAT MODES",
        title: summarizeChatModes(capabilities),
        description: capabilities?.chat_api_modes.responses.message ?? "Chat API mode support is loading.",
      },
      {
        label: "STREAMING",
        title: streamingReady ? "Available" : "Unavailable",
        description:
          capabilities?.streaming.message ??
          "Streaming readiness is loading.",
      },
      {
        label: "RUNTIME",
        title: `${capabilities?.vector_store ?? "Loading"} • ${capabilities?.model_runtime ?? "Loading"}`,
        description:
          "The dashboard reflects live runtime identity so operators can confirm the active vector store and model stack before changing providers or running syncs.",
      },
    ],
    [capabilities, cloudReady, streamingReady],
  );

  return (
    <div className="space-y-5">
      <div className="flex max-w-[1200px] flex-wrap gap-2">
        {cards.map((card) => (
          <GhostCard key={card.label} {...card} />
        ))}
      </div>

      <section className="grid gap-4 md:grid-cols-[1.25fr_0.95fr]">
        <article className="glass rounded-xl border border-slate-200 p-5">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Knowledge Status</p>
          <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Ingress overview</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="text-[1.55rem] font-bold text-slate-900">{vectorStats?.documents ?? "..."}</div>
              <div className="text-[0.75rem] text-slate-500">Total files tracked (aggregate)</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="text-[1.55rem] font-bold text-slate-900">{runs.length}</div>
              <div className="text-[0.75rem] text-slate-500">Recent sync runs</div>
            </div>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="text-[1.2rem] font-semibold text-slate-900">{vectorStats?.pdf_documents ?? "..."}</div>
              <div className="text-[0.72rem] text-slate-500">PDF</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="text-[1.2rem] font-semibold text-slate-900">{vectorStats?.xlsx_documents ?? "..."}</div>
              <div className="text-[0.72rem] text-slate-500">XLSX/XLSM</div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="text-[1.2rem] font-semibold text-slate-900">{vectorStats?.txt_documents ?? "..."}</div>
              <div className="text-[0.72rem] text-slate-500">TXT-like</div>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.78rem] leading-6 text-slate-500">
            Storage is currently backed by Postgres for metadata/provenance and Qdrant for vector retrieval. The totals above come from the authoritative
            {" "}
            <span className="font-semibold text-slate-900">`/api/vector-stats`</span>
            {" "}
            surface, while the recent-documents panel below remains a capped operator preview for quick scanning.
          </div>
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Runtime Defaults</p>
          <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Active operator path</h2>
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-400">Provider</div>
                <div className="mt-1 text-[0.82rem] font-semibold text-slate-900">
                  {activeConnection?.label ?? "No enabled provider"}
                </div>
                <div className="mt-1 text-[0.72rem] text-slate-500">
                  {activeConnection?.base_url ?? "Using default provider base URL"}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-400">Chat API Mode</div>
                <div className="mt-1 text-[0.82rem] font-semibold text-slate-900">
                  {formatApiMode(runtimeDefaults?.chat_api_mode)}
                </div>
                <div className="mt-1 text-[0.72rem] text-slate-500">
                  Persisted operator default loaded from runtime state.
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-400">Chat Model</div>
                <div className="mt-1 text-[0.82rem] font-semibold text-slate-900">
                  {runtimeDefaults?.llm_model_id ?? "Loading"}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-400">Embedding Model</div>
                <div className="mt-1 text-[0.82rem] font-semibold text-slate-900">
                  {runtimeDefaults?.embedding_model_id ?? "Loading"}
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white/80 p-3 sm:col-span-2">
                <div className="text-[0.65rem] font-bold uppercase tracking-[0.16em] text-slate-400">Default Corpora</div>
                <div className="mt-1 text-[0.82rem] font-semibold text-slate-900">
                  {(runtimeDefaults?.default_corpora ?? []).join(", ") || "default"}
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.76rem] leading-6 text-slate-500">
              The active runtime is currently backed by <span className="font-semibold text-slate-900">{capabilities?.vector_store ?? "..."}</span> for retrieval and{" "}
              <span className="font-semibold text-slate-900">{capabilities?.model_runtime ?? "..."}</span> for orchestration.
            </div>
          </div>
        </article>
      </section>

      <section className="grid gap-4 md:grid-cols-[0.95fr_1.25fr]">
        <article className="glass rounded-xl border border-slate-200 p-5">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Recent Runs</p>
          <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Operational snapshot</h2>
          <div className="mt-4 space-y-3">
            {runs.slice(0, 4).map((run) => (
              <div key={run.id} className="rounded-xl border border-slate-200 bg-white/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[0.82rem] font-semibold text-slate-900">{run.corpus}</div>
                  <div className={`text-[0.72rem] font-semibold ${statusTone(run.status)}`}>{run.status}</div>
                </div>
                <div className="mt-1 text-[0.72rem] text-slate-500">{run.current_step.replaceAll("_", " ")} • {Math.round(run.progress * 100)}%</div>
                {run.error_message && <div className="mt-2 text-[0.7rem] text-rose-600">{run.error_message}</div>}
              </div>
            ))}
            {runs.length === 0 && (
              <div className="rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.78rem] text-slate-500">
                No sync runs have been recorded yet.
              </div>
            )}
          </div>
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5">
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Recent Documents</p>
          <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Ingestion state</h2>
          <div className="mt-2 text-[0.76rem] leading-6 text-slate-500">
            Showing the latest six records from the recent-documents feed. Aggregate collection totals are reported in the Knowledge Status cards above.
          </div>
          <div className="mt-4 space-y-3">
            {recentDocuments.map((document) => (
              <div key={document.id} className="rounded-xl border border-slate-200 bg-white/80 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[0.82rem] font-semibold text-slate-900">{document.filename}</div>
                    <div className="mt-1 text-[0.72rem] text-slate-500">
                      requested: {document.requested_lane} • actual: {document.actual_parse_lane ?? "pending"}
                    </div>
                    <div className="mt-1 text-[0.72rem] text-slate-500">
                      {document.workbook_table_count > 0
                        ? `${document.workbook_sheet_count} sheet(s) • ${document.workbook_table_count} table(s) • ${document.workbook_row_count} row(s)`
                        : "Document artifact ready for retrieval indexing"}
                    </div>
                    {document.error_message && <div className="mt-2 text-[0.7rem] text-rose-600">{document.error_message}</div>}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-[0.64rem] font-semibold ${badgeTone(document.parse_status)}`}>
                      parse {document.parse_status}
                    </span>
                    <span className={`rounded-full border px-2.5 py-1 text-[0.64rem] font-semibold ${badgeTone(document.index_status)}`}>
                      index {document.index_status}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            {recentDocuments.length === 0 && (
              <div className="rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.78rem] text-slate-500">
                No recent document ingestion state is available yet.
              </div>
            )}
          </div>
        </article>
      </section>
    </div>
  );
}
