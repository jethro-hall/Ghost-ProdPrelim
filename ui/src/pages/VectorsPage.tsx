import { useEffect, useMemo, useState } from "react";
import { fetchDocuments } from "../api";
import type { DocumentIngestion } from "../api";

export default function VectorsPage() {
  const [documents, setDocuments] = useState<DocumentIngestion[]>([]);

  useEffect(() => {
    void fetchDocuments().then(setDocuments).catch(() => null);
  }, []);

  const stats = useMemo(() => {
    return documents.reduce(
      (acc, document) => {
        acc.documents += 1;
        acc.vectorArtifacts += document.artifacts.length;
        acc.workbookRows += document.workbook_row_count;
        return acc;
      },
      { documents: 0, vectorArtifacts: 0, workbookRows: 0 },
    );
  }, [documents]);

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Vector DBs</p>
        <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Qdrant collection monitoring</h2>
        <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
          Monitoring the live `ghostdash_knowledge` collection. This page is the designer’s vector-storage surface adapted to the current Qdrant-backed retrieval stack.
        </p>
      </section>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="glass rounded-xl border border-slate-200 p-5">
          <div className="text-[1.5rem] font-bold text-slate-900">{stats.documents}</div>
          <div className="text-[0.74rem] text-slate-500">Documents with tracked state</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-5">
          <div className="text-[1.5rem] font-bold text-slate-900">{stats.vectorArtifacts}</div>
          <div className="text-[0.74rem] text-slate-500">Retrieval artifacts surfaced</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-5">
          <div className="text-[1.5rem] font-bold text-slate-900">{stats.workbookRows}</div>
          <div className="text-[0.74rem] text-slate-500">Structured workbook rows</div>
        </div>
      </div>
    </div>
  );
}
