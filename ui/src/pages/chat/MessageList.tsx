import { type ReactNode, useEffect, useRef } from "react";
import { type ChatEntry } from "../../hooks/useChatEngine";
import type { ConversationMode, WorkflowMode } from "../../api";
import AgentToolTrace, { shouldShowMultiAgentToolTrace } from "../../components/chat/AgentToolTrace";
import BpBoardSummary from "../../components/chat/BpBoardSummary";

type Props = {
  log: ChatEntry[];
  busy: boolean;
  firstMessage: string;
  workflowMode: WorkflowMode;
  conversationMode: ConversationMode;
  docxModeEnabled?: boolean;
  onApproveMessage: (messageId: string) => Promise<unknown>;
  onRejectMessage: (messageId: string) => void;
  documentDecisionByMessage: Record<string, "approved" | "rejected">;
};

type ParsedBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "divider" }
  | { kind: "code"; content: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "image"; alt: string; src: string };

function parseInline(text: string): ReactNode[] {
  const output: ReactNode[] = [];
  const tokenPattern = /(`[^`]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|!\[[^\]]*\]\([^)]+\))/g;
  let cursor = 0;
  let tokenIndex = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const [token] = match;
    const start = match.index ?? 0;
    if (start > cursor) {
      output.push(text.slice(cursor, start));
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      output.push(
        <code key={`inline-code-${tokenIndex++}`} className="rounded bg-slate-900 px-1.5 py-0.5 text-[0.86em] text-slate-100">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      output.push(
        <strong key={`inline-strong-${tokenIndex++}`} className="font-semibold text-slate-900">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      output.push(
        <em key={`inline-em-${tokenIndex++}`} className="text-[0.95em] italic text-slate-600">
          {token.slice(1, -1)}
        </em>,
      );
    } else {
      const imageMatch = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imageMatch) {
        output.push(
          <img
            key={`inline-img-${tokenIndex++}`}
            src={imageMatch[2]}
            alt={imageMatch[1] || "image"}
            className="my-2 max-h-64 w-auto rounded-lg border border-slate-200 object-contain"
          />,
        );
      } else {
        output.push(token);
      }
    }
    cursor = start + token.length;
  }
  if (cursor < text.length) {
    output.push(text.slice(cursor));
  }
  return output.length > 0 ? output : [text];
}

function parseMessageBlocks(text: string): ParsedBlock[] {
  const lines = text.split("\n");
  const blocks: ParsedBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trimEnd() ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (trimmed === "---" || trimmed === "***") {
      blocks.push({ kind: "divider" });
      index += 1;
      continue;
    }
    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", content: codeLines.join("\n") });
      continue;
    }
    if (trimmed.startsWith("![")) {
      const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (imageMatch) {
        blocks.push({ kind: "image", alt: imageMatch[1], src: imageMatch[2] });
        index += 1;
        continue;
      }
    }
    if (trimmed.startsWith("#")) {
      const level = Math.min(4, (trimmed.match(/^#+/)?.[0].length ?? 1));
      const headingText = trimmed.replace(/^#+\s*/, "").trim();
      blocks.push({ kind: "heading", level, text: headingText });
      index += 1;
      continue;
    }
    if ((trimmed.startsWith("- ") || trimmed.startsWith("* ")) && !trimmed.includes("|")) {
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = (lines[index] ?? "").trim();
        if (candidate.startsWith("- ") || candidate.startsWith("* ")) {
          items.push(candidate.slice(2).trim());
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (trimmed.includes("|")) {
      const headerParts = trimmed
        .split("|")
        .map((part) => part.trim())
        .filter(Boolean);
      const separator = (lines[index + 1] ?? "").trim();
      const isTable = /^[:\-\|\s]+$/.test(separator) && separator.includes("-");
      if (isTable && headerParts.length > 1) {
        index += 2;
        const rows: string[][] = [];
        while (index < lines.length) {
          const candidate = (lines[index] ?? "").trim();
          if (!candidate.includes("|") || !candidate) {
            break;
          }
          const rowParts = candidate
            .split("|")
            .map((part) => part.trim())
            .filter(Boolean);
          if (rowParts.length > 0) {
            rows.push(rowParts);
          }
          index += 1;
        }
        blocks.push({ kind: "table", headers: headerParts, rows });
        continue;
      }
    }
    const paragraphLines: string[] = [trimmed];
    index += 1;
    while (index < lines.length) {
      const candidate = (lines[index] ?? "").trim();
      if (!candidate || candidate.startsWith("#") || candidate.startsWith("- ") || candidate.startsWith("* ") || candidate.startsWith("```")) {
        break;
      }
      if (candidate.includes("|") && /^[:\-\|\s]+$/.test((lines[index + 1] ?? "").trim())) {
        break;
      }
      paragraphLines.push(candidate);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
  }
  return blocks;
}

function renderMessageContent(text: string): ReactNode {
  const blocks = parseMessageBlocks(text);
  if (blocks.length === 0) {
    return <span>{text}</span>;
  }
  return (
    <div className="space-y-2.5">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          const classes =
            block.level <= 1
              ? "text-[1rem] font-bold tracking-tight text-slate-900"
              : block.level === 2
                ? "text-[0.95rem] font-semibold text-slate-900"
                : "text-[0.9rem] font-semibold text-slate-800";
          return (
            <div key={`heading-${index}`} className={classes}>
              {parseInline(block.text)}
            </div>
          );
        }
        if (block.kind === "paragraph") {
          return (
            <p key={`paragraph-${index}`} className="leading-relaxed text-slate-800">
              {parseInline(block.text)}
            </p>
          );
        }
        if (block.kind === "list") {
          return (
            <ul key={`list-${index}`} className="list-disc space-y-1 pl-5 text-slate-800">
              {block.items.map((item, itemIndex) => (
                <li key={`item-${index}-${itemIndex}`}>{parseInline(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "divider") {
          return <hr key={`divider-${index}`} className="border-slate-300" />;
        }
        if (block.kind === "code") {
          return (
            <pre key={`code-${index}`} className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-950 p-3 text-[0.78rem] text-slate-100">
              <code>{block.content}</code>
            </pre>
          );
        }
        if (block.kind === "image") {
          return (
            <div key={`image-${index}`} className="overflow-hidden rounded-lg border border-slate-200">
              <img src={block.src} alt={block.alt || "image"} className="max-h-80 w-full object-contain bg-slate-50" />
            </div>
          );
        }
        return (
          <div key={`table-${index}`} className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[480px] border-collapse text-left text-[0.78rem]">
              <thead className="bg-slate-50">
                <tr>
                  {block.headers.map((header, headerIndex) => (
                    <th key={`header-${headerIndex}`} className="border-b border-slate-200 px-2.5 py-2 font-semibold text-slate-700">
                      {parseInline(header)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={`row-${rowIndex}`} className={rowIndex % 2 === 0 ? "bg-white" : "bg-slate-50/50"}>
                    {row.map((cell, cellIndex) => (
                      <td key={`cell-${rowIndex}-${cellIndex}`} className="border-b border-slate-100 px-2.5 py-1.5 text-slate-700">
                        {parseInline(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function extractBpMetricRows(entry: ChatEntry): Array<{ metric: string; burleigh: number | null; brisbane: number | null; higherIsBetter?: boolean }> {
  const branchMetrics: Record<string, Record<string, number>> = {};
  const candidateRows: Array<Record<string, unknown>> = [];
  for (const event of entry.toolEvents ?? []) {
    if (event.tool_id !== "odoo_primary" || event.status !== "executed") continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const response = (payload.response ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(response.rows) ? (response.rows as Array<Record<string, unknown>>) : [];
    const companies = Array.isArray(response.companies) ? (response.companies as Array<Record<string, unknown>>) : [];
    candidateRows.push(...rows, ...companies);
  }
  for (const row of candidateRows) {
      const companyName = String(row.company_name ?? row.company ?? "").trim().toLowerCase();
      if (!companyName) continue;
      const key = companyName.includes("burleigh") ? "burleigh" : companyName.includes("brisbane") ? "brisbane" : "";
      if (!key) continue;
      branchMetrics[key] = {
        ...(branchMetrics[key] ?? {}),
        revenue: Number(row.revenue ?? row.revenue_total ?? row.operating_income ?? 0),
        cogs: Number(row.cogs ?? row.cost_of_goods ?? row.cost_of_revenue ?? 0),
        gp: Number(row.gp ?? row.gross_profit ?? row.total_gross_profit ?? 0),
        net: Number(row.net ?? row.net_profit ?? 0),
        roas: Number(row.roas ?? row.roi ?? 0),
      };
  }
  if (!branchMetrics.burleigh && !branchMetrics.brisbane) {
    return [];
  }
  return [
    { metric: "COGS", burleigh: branchMetrics.burleigh?.cogs ?? null, brisbane: branchMetrics.brisbane?.cogs ?? null, higherIsBetter: false },
    { metric: "GP", burleigh: branchMetrics.burleigh?.gp ?? null, brisbane: branchMetrics.brisbane?.gp ?? null, higherIsBetter: true },
    { metric: "Revenue", burleigh: branchMetrics.burleigh?.revenue ?? null, brisbane: branchMetrics.brisbane?.revenue ?? null, higherIsBetter: true },
    { metric: "Net", burleigh: branchMetrics.burleigh?.net ?? null, brisbane: branchMetrics.brisbane?.net ?? null, higherIsBetter: true },
    { metric: "ROAS", burleigh: branchMetrics.burleigh?.roas ?? null, brisbane: branchMetrics.brisbane?.roas ?? null, higherIsBetter: true },
  ];
}

export default function MessageList({
  log,
  busy,
  firstMessage,
  workflowMode,
  conversationMode,
  docxModeEnabled = false,
  onApproveMessage,
  onRejectMessage,
  documentDecisionByMessage,
}: Props) {
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
            <p className="max-w-md text-sm text-slate-600 leading-relaxed">
              {firstMessage}
            </p>
          </div>
        )}

        {/* Message Stream */}
        {log.map((entry, index) => {
          const isUser = entry.role === "user";
          const showToolLegend =
            !isUser &&
            shouldShowMultiAgentToolTrace(
              entry.routeDecision?.route_type,
              conversationMode,
              entry.toolEvents?.length ?? 0,
            );
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
                } ${showToolLegend ? "pr-[15.5rem] pt-8" : ""}`}
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

                {!isUser && entry.routeDecision?.rationale_summary && (
                  <div className="mb-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[0.72rem] leading-snug text-slate-700">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-[0.14em] text-slate-700">
                        Route: {entry.routeDecision.route_type}
                      </span>
                      {entry.routeDecision.document_intent && (
                        <span className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[0.62rem] font-semibold text-indigo-700">
                          Document intent
                        </span>
                      )}
                    </div>
                    <div className="text-slate-600">{entry.routeDecision.rationale_summary}</div>
                    {(entry.routeDecision.llm_execution ?? []).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(entry.routeDecision.llm_execution ?? []).map((step, idx) => (
                          <span
                            key={`${step.stage}-${step.model_id}-${idx}`}
                            className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[0.62rem] font-medium text-slate-600"
                            title={`${step.connection_label ?? step.provider} • ${step.model_id} • in ${step.prompt_tokens} / out ${step.completion_tokens}`}
                          >
                            {step.stage}: {step.model_id} (in {step.prompt_tokens}, out {step.completion_tokens})
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {!isUser && entry.toolEvents && entry.toolEvents.length > 0 && (
                  <AgentToolTrace
                    toolEvents={entry.toolEvents}
                    routeType={entry.routeDecision?.route_type}
                    conversationMode={conversationMode}
                  />
                )}

                {!isUser &&
                  !shouldShowMultiAgentToolTrace(
                    entry.routeDecision?.route_type,
                    conversationMode,
                    entry.toolEvents?.length ?? 0,
                  ) &&
                  ((entry.toolEvents?.length ?? 0) > 0 || citationSourceBadges(entry).length > 0) && (
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
                  {isUser ? entry.text : renderMessageContent(entry.text)}
                  {/* Streaming indicator dot */}
                  {!isUser && busy && index === log.length - 1 && !entry.text.endsWith("...") && (
                    <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-ghost-orange align-middle"></span>
                  )}
                </div>
                {!isUser && workflowMode === "bp_mode" && (
                  <BpBoardSummary
                    rows={extractBpMetricRows(entry)}
                    explanation={entry.routeDecision?.tool_expectations?.bp_audit ? "Auditor gate has evaluated this board output." : undefined}
                  />
                )}
                {!isUser && entry.llmIo && (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[0.66rem] text-slate-600">
                    <div className="flex flex-wrap gap-3">
                      <span>IN <span className="font-mono tabular-nums text-slate-800">{entry.llmIo.input_tokens.toLocaleString()}</span></span>
                      <span>OUT <span className="font-mono tabular-nums text-slate-800">{entry.llmIo.output_tokens.toLocaleString()}</span></span>
                      <span>TOTAL <span className="font-mono tabular-nums text-slate-800">{entry.llmIo.total_tokens.toLocaleString()}</span></span>
                    </div>
                    {(entry.llmIo.input_first_text || entry.llmIo.input_last_text) && (
                      <div className="mt-1 space-y-0.5">
                        <div><span className="font-semibold text-slate-700">Input first:</span> {entry.llmIo.input_first_text || "n/a"}</div>
                        <div><span className="font-semibold text-slate-700">Input last:</span> {entry.llmIo.input_last_text || "n/a"}</div>
                      </div>
                    )}
                  </div>
                )}
                
                {/* Citations */}
                {!isUser && entry.citations && entry.citations.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                    {entry.citations.map((cite: any, i) => (
                      <span key={i} className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[0.65rem] font-medium text-slate-700">
                        {cite.filename || `Doc ${i+1}`}
                      </span>
                    ))}
                  </div>
                )}
                {!isUser && entry.text.trim() && workflowMode !== "documenter" && !docxModeEnabled && (
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                    {documentDecisionByMessage[entry.id] && (
                      <span
                        className={`rounded-full px-3 py-1 text-[0.68rem] font-semibold ${
                          documentDecisionByMessage[entry.id] === "approved"
                            ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border border-rose-200 bg-rose-50 text-rose-700"
                        }`}
                      >
                        {documentDecisionByMessage[entry.id] === "approved" ? "Approved for document" : "Rejected"}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void onApproveMessage(entry.id)}
                      className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[0.68rem] font-semibold text-emerald-700 transition-colors hover:bg-emerald-100"
                    >
                      Approve for document
                    </button>
                    <button
                      type="button"
                      onClick={() => onRejectMessage(entry.id)}
                      className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-[0.68rem] font-semibold text-rose-700 transition-colors hover:bg-rose-100"
                    >
                      Reject
                    </button>
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
