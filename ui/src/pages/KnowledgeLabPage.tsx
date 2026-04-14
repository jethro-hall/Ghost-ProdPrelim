import { useEffect, useState } from "react";
import { fetchDocuments } from "../api";
import type { DocumentIngestion } from "../api";

export default function KnowledgeLabPage() {
  const [documents, setDocuments] = useState<DocumentIngestion[]>([]);

  useEffect(() => {
    void fetchDocuments().then(setDocuments).catch(() => null);
  }, []);

  return (
    <div className="knowledge-lab-page space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Knowledge lab</p>
            <h2 className="mt-1 text-[1rem] font-semibold text-slate-900">Corpus quality audit</h2>
          </div>
          <button type="button" className="ghost-btn-primary" disabled>
            Audit pending
          </button>
        </div>
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="glass rounded-xl border border-slate-200 p-4">
          <div className="text-[0.84rem] font-semibold text-slate-900">Current system footprint</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4">
              <div className="text-[1.35rem] font-bold text-slate-900">{documents.length}</div>
              <div className="text-[0.74rem] text-slate-500">Available documents</div>
            </div>
          </div>
        </section>

        <aside className="glass rounded-xl border border-slate-200 p-3">
          <div className="space-y-3">
            <section className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.72rem] text-amber-700">
              Next backend step: sample nodes, score completeness/provenance/consistency, and generate the audit roadmap.
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
