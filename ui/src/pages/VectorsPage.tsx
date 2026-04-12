import { useEffect, useState } from "react";
import { fetchVectorStats } from "../api";
import type { VectorStats } from "../api";

export default function VectorsPage() {
  const [stats, setStats] = useState<VectorStats | null>(null);

  useEffect(() => {
    void fetchVectorStats().then(setStats).catch(() => null);
  }, []);

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Vector DBs</p>
        <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Qdrant collection monitoring</h2>
        <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
          Monitoring the live Qdrant backing collection for the current embedding generation. These are system-wide aggregate totals across all managed logical collections, not a single namespace.
          {" "}
          They come from the authoritative aggregate
          {" "}
          <span className="font-semibold text-slate-900">`/api/vector-stats`</span>
          {" "}
          surface rather than the capped recent-documents list.
        </p>
      </section>
      <div className="grid gap-4 sm:grid-cols-3">
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
      <div className="grid gap-4 sm:grid-cols-4">
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
      </div>
    </div>
  );
}
