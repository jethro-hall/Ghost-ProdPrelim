import { useEffect, useRef } from "react";
import { type ChatEntry } from "../../hooks/useChatEngine";

type Props = {
  log: ChatEntry[];
  busy: boolean;
  firstMessage: string;
};

export default function MessageList({ log, busy, firstMessage }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const citationSourceBadges = (entry: ChatEntry) =>
    (entry.citations ?? [])
      .filter((cite: any) => cite?.source_type === "tool")
      .map((cite: any, index) => ({
        id: `cite-${index}`,
        label: cite?.title || cite?.filename || "Odoo",
      }));
  
  // Auto-scroll on new messages or streaming chunks
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [log, busy]);

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-5 md:p-6">
      <div className="mx-auto w-full max-w-[1200px] space-y-4">
        
        {/* Empty State */}
        {log.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 shadow-sm border border-slate-200">
              <span className="text-3xl" aria-hidden="true">👻</span>
            </div>
            <h2 className="mb-2 text-xl font-bold tracking-tight text-slate-900">
              How can I help you today?
            </h2>
            <p className="max-w-md text-sm text-slate-500 leading-relaxed">
              {firstMessage}
            </p>
          </div>
        )}

        {/* Message Stream */}
        {log.map((entry, index) => {
          const isUser = entry.role === "user";
          return (
            <div 
              key={entry.id} 
              className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
            >
              <div 
                className={`group relative max-w-[88%] md:max-w-[78%] rounded-2xl px-4 py-3 text-[0.92rem] leading-relaxed shadow-sm transition-all ${
                  isUser 
                    ? "rounded-br-sm bg-slate-900 text-white" 
                    : "rounded-bl-sm border border-slate-200 bg-white text-slate-900"
                }`}
              >
                {/* Tool / Query Mode Indicator */}
                {!isUser && entry.queryMode && (
                  <div className="mb-2 flex items-center gap-1.5 text-[0.65rem] font-bold uppercase tracking-[0.16em] text-ghost-orange">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                    </svg>
                    {entry.queryMode}
                  </div>
                )}

                {!isUser && ((entry.toolEvents?.length ?? 0) > 0 || citationSourceBadges(entry).length > 0) && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {(entry.toolEvents ?? []).map((toolEvent, idx) => (
                      <span
                        key={`${toolEvent.tool_id}-${toolEvent.operation ?? "none"}-${idx}`}
                        className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[0.65rem] font-medium text-slate-600"
                      >
                        {toolEvent.status === "executed"
                          ? `Verified via ${toolEvent.operation ?? toolEvent.tool_id}`
                          : toolEvent.status === "preview"
                            ? `Planned ${toolEvent.operation ?? toolEvent.tool_id}`
                            : `Odoo ${toolEvent.status}`}
                      </span>
                    ))}
                    {citationSourceBadges(entry).map((badge) => (
                      <span
                        key={badge.id}
                        className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[0.65rem] font-medium text-emerald-700"
                      >
                        {badge.label}
                      </span>
                    ))}
                  </div>
                )}
                
                {/* Message Content */}
                <div className="whitespace-pre-wrap break-words">
                  {entry.text}
                  {/* Streaming indicator dot */}
                  {!isUser && busy && index === log.length - 1 && !entry.text.endsWith("...") && (
                    <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-ghost-orange align-middle"></span>
                  )}
                </div>
                
                {/* Citations */}
                {!isUser && entry.citations && entry.citations.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                    {entry.citations.map((cite: any, i) => (
                      <span key={i} className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[0.65rem] font-medium text-slate-500">
                        {cite.filename || `Doc ${i+1}`}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} className="h-4" />
      </div>
    </div>
  );
}
