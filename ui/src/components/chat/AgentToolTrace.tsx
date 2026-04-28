import type { ChatToolEvent, ConversationMode, RouteType } from "../../api";

const PAYLOAD_PREVIEW_CHARS = 12_000;

function toolConnectorLabel(toolId: string): string {
  const id = toolId.trim();
  if (id === "odoo_primary") return "Odoo";
  if (id === "approved_web") return "Approved web";
  if (id === "agent.finance_analyst") return "Finance Analyst";
  if (id === "agent.business_documenter") return "Business Documenter";
  if (id.startsWith("agent.")) return "Sub-agent";
  if (id.startsWith("odoo_")) return "Odoo";
  return id || "Tool";
}

function statusLabel(status: ChatToolEvent["status"]): string {
  switch (status) {
    case "executed":
      return "Executed";
    case "preview":
      return "Preview";
    case "planned":
      return "Planned";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function formatPayload(payload: Record<string, unknown> | undefined): string {
  if (!payload || Object.keys(payload).length === 0) return "";
  try {
    const raw = JSON.stringify(payload, null, 2);
    if (raw.length <= PAYLOAD_PREVIEW_CHARS) return raw;
    return `${raw.slice(0, PAYLOAD_PREVIEW_CHARS)}\n… (truncated)`;
  } catch {
    return String(payload);
  }
}

function executionTruthLabel(payload: Record<string, unknown> | undefined): string | null {
  const truth = (payload?.execution_truth ?? null) as Record<string, unknown> | null;
  if (!truth || typeof truth !== "object") return null;
  const dateFrom = typeof truth.date_from === "string" ? truth.date_from : null;
  const dateTo = typeof truth.date_to === "string" ? truth.date_to : null;
  const companyId = typeof truth.company_id === "number" || typeof truth.company_id === "string" ? String(truth.company_id) : null;
  const companyIds = Array.isArray(truth.company_ids) ? truth.company_ids.map((entry) => String(entry)).join(",") : "";
  const companyTerms = Array.isArray(truth.company_name_terms) ? truth.company_name_terms.map((entry) => String(entry)).join(",") : "";
  const scopeLock =
    typeof truth.company_scope_lock === "string" && truth.company_scope_lock
      ? truth.company_scope_lock
      : null;
  const scopeCanonical =
    typeof truth.company_scope_lock_canonical === "string" && truth.company_scope_lock_canonical
      ? truth.company_scope_lock_canonical
      : null;
  const scopeEnforced = truth.scope_enforced === true ? "enforced" : null;
  const source = typeof truth.evidence_source_mode === "string" ? truth.evidence_source_mode : null;
  const pieces = [
    source ? `source:${source}` : null,
    dateFrom && dateTo ? `window:${dateFrom}->${dateTo}` : null,
    companyId ? `company:${companyId}` : null,
    !companyId && companyIds ? `companies:${companyIds}` : null,
    !companyId && !companyIds && companyTerms ? `scope:${companyTerms}` : null,
    scopeLock && scopeCanonical ? `lock:${scopeCanonical}` : scopeLock ? `lock:${scopeLock}` : null,
    scopeEnforced,
  ].filter(Boolean);
  return pieces.length ? pieces.join(" | ") : null;
}

export function shouldShowMultiAgentToolTrace(
  routeType: RouteType | string | undefined,
  conversationMode: ConversationMode,
  toolEventCount: number,
): boolean {
  if (toolEventCount === 0) return false;
  return routeType === "workers" || conversationMode === "working_session";
}

type Props = {
  toolEvents: ChatToolEvent[];
  routeType?: RouteType | string | null;
  conversationMode: ConversationMode;
};

export default function AgentToolTrace({ toolEvents, routeType, conversationMode }: Props) {
  if (!shouldShowMultiAgentToolTrace(routeType ?? undefined, conversationMode, toolEvents.length)) {
    return null;
  }

  return (
    <aside className="absolute right-2 top-2 z-10 max-w-[70%] rounded-lg border border-indigo-200 bg-indigo-50/95 px-2 py-1.5 shadow-sm backdrop-blur-sm">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span
          className="text-[0.58rem] font-bold uppercase tracking-[0.14em] text-indigo-800"
          title="Server-executed connectors and sub-agents used for this answer"
        >
          Execution legend
        </span>
        <span className="rounded-full border border-indigo-200 bg-white px-1.5 py-0.5 text-[0.56rem] font-semibold text-indigo-700">
          {toolEvents.length}
        </span>
      </div>
      <ul className="space-y-1">
        {toolEvents.map((ev, idx) => {
          const connector = toolConnectorLabel(ev.tool_id);
          const operation = ev.operation ?? ev.tool_id;
          const payloadText = formatPayload(ev.payload);
          const truthLabel = executionTruthLabel(ev.payload);
          const detailTitle = [ev.summary, payloadText ? "Payload available" : "", ev.blocked_reason ? `Blocked: ${ev.blocked_reason}` : ""]
            .filter(Boolean)
            .join(" • ");
          return (
            <li
              key={`${ev.tool_id}-${ev.operation ?? "op"}-${ev.status}-${idx}`}
              className="flex items-center gap-1.5 rounded-md border border-indigo-100/90 bg-white/90 px-1.5 py-1 text-[0.62rem] leading-snug text-slate-800"
              title={detailTitle || operation}
            >
              <span className="max-w-[11rem] truncate font-semibold text-slate-900">
                {connector}
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[0.54rem] font-bold uppercase tracking-wide ${
                  ev.status === "executed"
                    ? "border border-emerald-200 bg-emerald-50 text-emerald-800"
                    : ev.status === "preview" || ev.status === "planned"
                      ? "border border-amber-200 bg-amber-50 text-amber-900"
                      : "border border-rose-200 bg-rose-50 text-rose-800"
                }`}
              >
                <span className="inline-flex items-center gap-1">
                  {ev.status === "planned" && (
                    <span className="inline-block h-1.5 w-1.5 animate-spin rounded-full border border-amber-500 border-t-transparent" />
                  )}
                  {statusLabel(ev.status)}
                </span>
              </span>
              {typeof ev.latency_ms === "number" && (
                <span className="font-mono text-[0.56rem] text-slate-500">{Math.round(ev.latency_ms)}ms</span>
              )}
              {payloadText && <span className="text-[0.54rem] text-indigo-700">JSON</span>}
              {truthLabel && (
                <span className="truncate font-mono text-[0.52rem] text-indigo-600" title={truthLabel}>
                  {truthLabel}
                </span>
              )}
              <span className="sr-only">{operation}</span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
