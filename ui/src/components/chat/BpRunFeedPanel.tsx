import { useMemo } from "react";
import type { BpRunFeedEvent } from "../../hooks/useChatEngine";
import BpRunEventItem from "./BpRunEventItem";

type Props = {
  open: boolean;
  onToggle: () => void;
  events: BpRunFeedEvent[];
  tokenTotal: number;
  busy?: boolean;
};

export default function BpRunFeedPanel({ open, onToggle, events, tokenTotal, busy = false }: Props) {
  const toolCount = useMemo(() => events.filter((event) => event.kind === "tool").length, [events]);
  const audit = useMemo(
    () => [...events].reverse().find((event) => event.kind === "audit") ?? null,
    [events]
  );
  const latest = useMemo(() => [...events].reverse()[0] ?? null, [events]);
  const statusLine = latest?.detail || latest?.title || (busy ? "Thinking..." : "Idle");

  return (
    <aside className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-center justify-between gap-2 rounded-2xl px-3 py-2 text-left ${open ? "" : "py-2.5"}`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[0.68rem] font-semibold uppercase tracking-[0.15em] text-slate-500">BP Running List</span>
            {busy && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[0.62rem] font-semibold text-emerald-700">
                <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-emerald-300 border-t-emerald-600" />
                Thinking
              </span>
            )}
          </div>
          <div className={`truncate ${open ? "text-[0.78rem] text-slate-700" : "text-[0.72rem] text-slate-600"}`}>
            {open
              ? `Events ${events.length} | Tools ${toolCount} | Tokens ${tokenTotal.toLocaleString()}`
              : statusLine}
          </div>
        </div>
        <span className="text-xs font-semibold text-slate-600">{open ? "Collapse" : "Expand"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-slate-100 px-3 py-3">
          {audit && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[0.7rem] text-amber-800">
              Latest audit: {audit.title}
            </div>
          )}
          <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
            {events.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-[0.72rem] text-slate-500">
                No BP run events yet.
              </div>
            ) : (
              events.map((event) => <BpRunEventItem key={event.id} event={event} />)
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

