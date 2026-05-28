import type { BpRunFeedEvent } from "../../hooks/useChatEngine";

type Props = {
  event: BpRunFeedEvent;
};

function badgeClass(kind: BpRunFeedEvent["kind"]): string {
  if (kind === "audit") return "border-amber-300 bg-amber-50 text-amber-800";
  if (kind === "tool") return "border-blue-200 bg-blue-50 text-blue-700";
  if (kind === "done") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (kind === "start") return "border-violet-200 bg-violet-50 text-violet-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export default function BpRunEventItem({ event }: Props) {
  const when = new Date(event.ts);
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[0.72rem]">
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold ${badgeClass(event.kind)}`}>
          {event.kind}
        </span>
        <span className="font-mono text-[0.62rem] text-slate-500">{when.toLocaleTimeString()}</span>
      </div>
      <div className="mt-1 font-semibold text-slate-900">{event.title}</div>
      {event.detail && <div className="mt-1 text-slate-600">{event.detail}</div>}
    </div>
  );
}

