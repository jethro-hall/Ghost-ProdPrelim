import { useEffect, useState } from "react";
import { fetchVectorStats } from "../api";
import type { VectorStats } from "../api";

export default function VectorsPage() {
  const [stats, setStats] = useState<VectorStats | null>(null);

  useEffect(() => {
    void fetchVectorStats().then(setStats).catch(() => null);
  }, []);

  return (
    <div className="vectors-page space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Vector DBs</p>
            <h2 className="mt-1 text-[1rem] font-semibold text-slate-900">Qdrant collection monitoring</h2>
          </div>
          <div className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
            aggregate stats
          </div>
        </div>
      </section>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="glass rounded-xl border border-slate-200 p-5">
          <div className="text-[1.5rem] font-bold text-slate-900">{stats?.documents ?? "..."}</div>
          <div className="text-[0.74rem] text-slate-500">Documents with tracked state (aggregate)</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-5">
          <div className="text-[1.5rem] font-bold text-slate-900">{stats?.retrieval_artifacts ?? "..."}</div>
          <div className="text-[0.74rem] text-slate-500">Retrieval artifacts surfaced</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-5">
          <div className="text-[1.5rem] font-bold text-slate-900">{stats?.workbook_rows ?? "..."}</div>
          <div className="text-[0.74rem] text-slate-500">Structured workbook rows</div>
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px] 2xl:grid-cols-[minmax(0,1fr)_350px]">
        <section className="grid gap-3 sm:grid-cols-4">
        <div className="glass rounded-xl border border-slate-200 p-5">
          <div className="text-[1.2rem] font-semibold text-slate-900">{stats?.pdf_documents ?? "..."}</div>
          <div className="text-[0.74rem] text-slate-500">PDF documents</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-5">
          <div className="text-[1.2rem] font-semibold text-slate-900">{stats?.xlsx_documents ?? "..."}</div>
          <div className="text-[0.74rem] text-slate-500">XLSX/XLSM documents</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-5">
          <div className="text-[1.2rem] font-semibold text-slate-900">{stats?.txt_documents ?? "..."}</div>
          <div className="text-[0.74rem] text-slate-500">TXT-like documents</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-5">
          <div className="text-[1.2rem] font-semibold text-slate-900">{stats?.other_documents ?? "..."}</div>
          <div className="text-[0.74rem] text-slate-500">Other documents</div>
        </div>
        </section>
        <aside className="glass rounded-xl border border-slate-200 p-3 text-[0.72rem] text-slate-500">
          <div className="space-y-3">
            <section className="rounded-lg border border-slate-200 bg-white/80 p-2">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Data source</div>
              <div>
                These totals come from the authoritative <span className="font-semibold text-slate-900">`/api/vector-stats`</span> surface, not the capped recent-documents feed.
              </div>
            </section>
            <section className="rounded-lg border border-slate-200 bg-white/80 p-2">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Scope</div>
              <div>System-wide aggregate totals across all managed logical collections, not a single namespace.</div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
