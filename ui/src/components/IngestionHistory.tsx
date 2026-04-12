import { formatRequestedLane, type DocumentIngestion } from "../api";
import { FileTextIcon } from "./ReferenceIcons";

type Props = {
  history: DocumentIngestion[];
  onRefresh: () => void;
};

function dotColor(status: string) {
  if (status === "done" || status === "ready" || status === "indexed") return "#22c55e";
  if (status === "failed" || status === "error") return "#ef4444";
  return "#f59e0b";
}

export default function IngestionHistory({ history, onRefresh }: Props) {
  return (
    <div className="max-w-[650px]">
      <div className="mb-2 flex items-center justify-between border-b border-slate-200 pb-2">
        <h2 className="text-[0.9rem] font-semibold text-slate-900">Ingestion Status History</h2>
        <button type="button" className="ghost-btn" onClick={onRefresh}>
          Refresh
        </button>
      </div>

      <div className="flex flex-col gap-1">
        {history.length === 0 ? (
          <div className="glass rounded-md border border-slate-200 px-3 py-3 text-[0.8rem] text-slate-500">
            No recent documents yet.
          </div>
        ) : (
          history.map((item) => (
            <div
              key={item.id}
              className="glass group flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 transition-all duration-200 hover:border-slate-300 hover:bg-white"
            >
              <div className="flex items-center gap-2.5">
                <div className="flex h-[22px] w-[22px] items-center justify-center rounded border border-slate-200 bg-slate-50 text-slate-900">
                  <FileTextIcon size={12} />
                </div>
                <div>
                  <h3 className="max-w-[400px] truncate text-[0.8rem] font-semibold text-slate-900">{item.filename}</h3>
                  <p className="mt-0.5 text-[0.7rem] text-slate-500">
                    {item.corpus} | {formatRequestedLane(item.requested_lane)} requested | {item.actual_parse_lane ?? "pending"} actual
                  </p>
                  <p className="text-[0.7rem] text-slate-500">
                    parse: {item.parse_status} | index: {item.index_status}
                    {item.workbook_table_count > 0 && (
                      <>
                        {" | "}
                        {item.workbook_sheet_count} sheet(s), {item.workbook_table_count} table(s), {item.workbook_row_count} row(s)
                      </>
                    )}
                  </p>
                  {item.error_message && <p className="text-[0.7rem] text-rose-600">{item.error_message}</p>}
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <div className="flex gap-1 opacity-0 transition-all duration-200 group-hover:opacity-100">
                  {item.artifacts.slice(0, 2).map((artifact) => (
                    <span
                      key={`${item.id}-${artifact.artifact_type}`}
                      className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[0.64rem] text-slate-500"
                    >
                      {artifact.artifact_type}
                    </span>
                  ))}
                </div>
                <div className="ghost-status-dot" style={{ color: dotColor(item.overall_status), background: dotColor(item.overall_status) }} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
