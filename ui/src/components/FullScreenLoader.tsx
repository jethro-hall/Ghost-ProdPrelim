import { AnimatePresence, motion } from "framer-motion";
import type { Task, TaskDocument, TaskStep } from "../api";
import { CheckIcon, CloseIcon } from "./ReferenceIcons";

type Props = {
  open: boolean;
  task: Task | null;
  onClose?: () => void;
};

function stepClasses(step: TaskStep) {
  if (step.status === "completed") {
    return {
      row: "text-emerald-700",
      dot: "border-emerald-600 bg-emerald-600 text-white",
      label: "Completed",
    };
  }
  if (step.status === "failed") {
    return {
      row: "text-rose-700",
      dot: "border-rose-600 bg-rose-600 text-white",
      label: "Failed",
    };
  }
  if (step.status === "running") {
    return {
      row: "text-slate-900",
      dot: "border-amber-400 bg-amber-100 text-amber-700",
      label: "Running",
    };
  }
  return {
    row: "text-slate-400",
    dot: "border-slate-300 bg-white text-slate-300",
    label: "Pending",
  };
}

function documentStatus(document: TaskDocument) {
  if (document.overall_status === "indexed") return "Indexed";
  if (document.overall_status === "error") return "Failed";
  if (document.active) return "Working";
  if (document.parse_status === "completed" && document.index_status === "pending") return "Parsed";
  if (document.overall_status === "uploaded") return "Queued";
  return document.overall_status;
}

function documentTone(document: TaskDocument) {
  if (document.overall_status === "indexed") return "border-emerald-200 bg-emerald-50/80 text-emerald-700";
  if (document.overall_status === "error") return "border-rose-200 bg-rose-50/80 text-rose-700";
  if (document.active) return "border-amber-200 bg-amber-50/80 text-amber-700";
  return "border-slate-200 bg-white/80 text-slate-500";
}

export default function FullScreenLoader({ open, task, onClose }: Props) {
  const totalDocuments = task?.total_documents ?? 0;
  const completedDocuments = task?.completed_documents ?? 0;
  const failedDocuments = task?.failed_documents ?? 0;
  const activeOrdinal = task?.active_document_id ? Math.min(completedDocuments + failedDocuments + 1, totalDocuments) : completedDocuments + failedDocuments;
  const progressPercent = Math.max(0, Math.min(100, Math.round((task?.progress ?? 0) * 100)));

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30 backdrop-blur-[8px]"
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            className="glass-popup flex w-[min(680px,92vw)] flex-col gap-4 rounded-xl p-6"
          >
            <div className="flex items-center justify-between border-b border-black/5 pb-2">
              <div>
                <h2 className="flex items-center gap-2 text-[1.1rem] font-semibold text-slate-900">
                  <span className="h-1.5 w-1.5 rounded-full bg-ghost-orange shadow-[0_0_6px_var(--color-accent-neon)]" />
                  Full Sync
                </h2>
                <p className="mt-1 text-[0.74rem] text-slate-500">
                  {totalDocuments > 0 ? `File ${activeOrdinal} of ${totalDocuments}` : "Preparing sync run..."}
                  {task?.active_filename ? ` • ${task.active_filename}` : ""}
                </p>
              </div>
              {onClose && (
                <button type="button" onClick={onClose} className="ghost-icon-btn text-slate-500" aria-label="Close sync status">
                  <CloseIcon size={14} />
                </button>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-[0.75rem] text-slate-500">
                <span>{progressPercent}% complete</span>
                <span>
                  {completedDocuments} passed • {failedDocuments} failed
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${task?.status === "failed" ? "bg-rose-500" : "bg-ghost-orange"}`}
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              {task?.error_message && <p className="text-[0.74rem] text-rose-600">{task.error_message}</p>}
            </div>

            <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="space-y-2.5">
                {task?.steps.map((step) => {
                  const tone = stepClasses(step);
                  return (
                    <div key={step.id} className={`flex items-center justify-between gap-3 text-[0.85rem] font-medium ${tone.row}`}>
                      <div className="flex items-center gap-2.5">
                        <div className={`flex h-4 w-4 items-center justify-center rounded-full border-[1.5px] transition-all duration-200 ${tone.dot}`}>
                          {step.status === "completed" && <CheckIcon size={10} strokeWidth={3} />}
                          {step.status === "failed" && <CloseIcon size={9} strokeWidth={3} />}
                        </div>
                        {step.label}
                      </div>
                      <span className="text-[0.68rem] font-semibold uppercase tracking-[0.12em]">{tone.label}</span>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-[0.75rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  <span>Documents</span>
                  <span>{totalDocuments}</span>
                </div>
                <div className="max-h-[260px] space-y-2 overflow-y-auto pr-1">
                  {task?.documents.map((document) => (
                    <div key={document.id} className={`rounded-lg border px-3 py-2 ${documentTone(document)}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[0.78rem] font-semibold">{document.filename}</div>
                          <div className="mt-0.5 text-[0.68rem]">
                            parse: {document.parse_status} • index: {document.index_status} • lane: {document.requested_lane}
                          </div>
                        </div>
                        <div className="shrink-0 text-[0.68rem] font-semibold uppercase tracking-[0.12em]">{documentStatus(document)}</div>
                      </div>
                      {document.error_message && <div className="mt-1 text-[0.68rem] text-rose-600">{document.error_message}</div>}
                    </div>
                  ))}
                  {!task?.documents.length && (
                    <div className="rounded-lg border border-slate-200 bg-white/80 px-3 py-3 text-[0.76rem] text-slate-500">
                      Waiting for document inventory from the workflow runtime...
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
