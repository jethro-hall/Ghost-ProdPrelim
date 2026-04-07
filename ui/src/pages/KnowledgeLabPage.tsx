import { useEffect, useState } from "react";
import { fetchDocuments } from "../api";
import type { DocumentIngestion } from "../api";

export default function KnowledgeLabPage() {
  const [documents, setDocuments] = useState<DocumentIngestion[]>([]);

  useEffect(() => {
    void fetchDocuments().then(setDocuments).catch(() => null);
  }, []);

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Knowledge Lab</p>
            <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Corpus quality audit</h2>
            <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
              The designer handover expects a real `/api/audit` workflow. That endpoint does not exist in the live stack yet, so this page is the operator shell ready for the next backend slice rather than a fake-scoring demo.
            </p>
          </div>
          <button type="button" className="ghost-btn-primary" disabled>
            Audit endpoint pending
          </button>
        </div>
      </section>
      <section className="glass rounded-xl border border-slate-200 p-5 text-[0.8rem] text-slate-500">
        <div className="font-semibold text-slate-900">Current corpus footprint</div>
        <div className="mt-2">{documents.length} document(s) are currently available for future audit sampling.</div>
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[0.76rem] text-amber-700">
          Next backend step: sample nodes, score completeness/provenance/consistency, and generate the 10/10 roadmap the handover calls for.
        </div>
      </section>
    </div>
  );
}
