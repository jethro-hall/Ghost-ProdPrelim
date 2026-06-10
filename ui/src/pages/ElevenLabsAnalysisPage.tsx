import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate, useParams } from "react-router-dom";

import {
  buildElevenLabsAnalysisAudioUrl,
  fetchElevenLabsAnalysisConversation,
  fetchElevenLabsAnalysisConversations,
  fetchElevenLabsAnalysisHealth,
  fetchElevenLabsAnalysisTranscript,
  type ElevenLabsAnalysisConversationDetail,
  type ElevenLabsAnalysisConversationSummary,
  type ElevenLabsAnalysisTranscriptTurn,
  type ElevenLabsAnalysisTranscript,
} from "../api";

type TabKey = "overview" | "workflow" | "transcription" | "client_data" | "phone_call";

type WorkflowCall = {
  id: string;
  name: string;
  status: string;
  source: string;
  latencyMs: number | null;
  startedAt: number | null;
  endedAt: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
};

type WorkflowFlowStep = {
  id: string;
  timeLabel: string;
  kind: "speech" | "route" | "tool_dispatch" | "tool_result";
  title: string;
  subtitle: string;
  status: string | null;
  latency: string | null;
  codeExecuted: string | null;
  requestPayload: unknown;
  resultPayload: unknown;
};

type ConversationEnrichment = {
  summary: string;
  userDataCaptured: string[];
  callerNumber: string | null;
  loading: boolean;
  error: string | null;
};

const PAGE_SIZE = 30;
type SortOption = "date_desc" | "status_asc";
const PANEL_SPRING = { type: "spring", stiffness: 300, damping: 30, mass: 0.9 } as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function summarizeJson(value: unknown) {
  if (value == null) return "Unavailable";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatLatencyMs(secondsValue: unknown) {
  if (typeof secondsValue !== "number" || !Number.isFinite(secondsValue)) return null;
  if (secondsValue >= 1) return `${secondsValue.toFixed(1)} s`;
  return `${Math.round(secondsValue * 1000)} ms`;
}

function readMetricLatency(turn: ElevenLabsAnalysisTranscriptTurn, metricKey: string) {
  const metricsRoot = asRecord(turn.metrics);
  const metrics = asRecord(metricsRoot?.metrics);
  const entry = asRecord(metrics?.[metricKey]);
  const elapsed = entry?.elapsed_time;
  return formatLatencyMs(elapsed);
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const candidate = value.trim();
  if (!candidate) return value;
  if (!(candidate.startsWith("{") || candidate.startsWith("["))) return value;
  try {
    return JSON.parse(candidate);
  } catch {
    return value;
  }
}

function toTimeLabel(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "n/a";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function detectCodeExecuted(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) return null;
  if (typeof record.function === "string" && record.function.trim()) return `function ${record.function.trim()}`;
  const nestedTools = asRecord(record.nested_tools);
  if (nestedTools) {
    const first = Object.keys(nestedTools)[0];
    if (first) return `nested tool ${first}`;
  }
  if (typeof record.operation === "string" && record.operation.trim()) return `operation ${record.operation.trim()}`;
  const data = asRecord(record.data);
  if (data && typeof data.operation === "string" && data.operation.trim()) return `operation ${data.operation.trim()}`;
  return null;
}

function buildWorkflowFlow(turns: ElevenLabsAnalysisTranscriptTurn[] | undefined): WorkflowFlowStep[] {
  if (!turns?.length) return [];
  const steps: WorkflowFlowStep[] = [];
  for (const turn of turns) {
    const baseId = String(turn.id || Math.random());
    const timeLabel = toTimeLabel(turn.start_time_seconds);

    if ((turn.message || "").trim()) {
      steps.push({
        id: `${baseId}-speech`,
        timeLabel,
        kind: "speech",
        title: (turn.role || "unknown").toLowerCase() === "user" ? "Caller utterance" : "Agent response",
        subtitle: (turn.message || "").trim(),
        status: null,
        latency: null,
        codeExecuted: null,
        requestPayload: null,
        resultPayload: null,
      });
    }

    const routeLatency = readMetricLatency(turn, "convai_llm_tool_request_generation_latency");
    if (routeLatency) {
      steps.push({
        id: `${baseId}-route`,
        timeLabel,
        kind: "route",
        title: "Workflow route",
        subtitle: "Workflow branch/condition evaluated",
        status: "routed",
        latency: routeLatency,
        codeExecuted: null,
        requestPayload: null,
        resultPayload: null,
      });
    }

    (turn.tool_calls || []).forEach((call, index) => {
      const callRecord = asRecord(call);
      const params = parseJsonString(callRecord?.params_as_json);
      const details = parseJsonString(callRecord?.tool_details);
      steps.push({
        id: `${baseId}-dispatch-${index}`,
        timeLabel,
        kind: "tool_dispatch",
        title: `Tool dispatch: ${String(callRecord?.tool_name ?? "tool")}`,
        subtitle: `Type: ${String(callRecord?.type ?? "tool")}`,
        status: callRecord?.tool_has_been_called === false ? "pending" : "sent",
        latency: null,
        codeExecuted: detectCodeExecuted(params),
        requestPayload: params ?? null,
        resultPayload: details ?? null,
      });
    });

    (turn.tool_results || []).forEach((result, index) => {
      const resultRecord = asRecord(result);
      const parsedResult = resultRecord?.result ?? parseJsonString(resultRecord?.result_value);
      const latency = formatLatencyMs(resultRecord?.tool_latency_secs);
      const status = resultRecord?.is_error ? "failed" : "succeeded";
      steps.push({
        id: `${baseId}-result-${index}`,
        timeLabel,
        kind: "tool_result",
        title: `Tool result: ${String(resultRecord?.tool_name ?? "tool")}`,
        subtitle: status === "failed" ? "Tool execution failed" : "Tool execution succeeded",
        status,
        latency,
        codeExecuted: detectCodeExecuted(parsedResult),
        requestPayload: null,
        resultPayload: parsedResult,
      });
    });
  }
  return steps;
}

function summarizeTranscript(turns: ElevenLabsAnalysisTranscriptTurn[] | undefined) {
  if (!turns?.length) return "Unavailable";
  const messages = turns
    .map((turn) => (turn.message || "").trim())
    .filter((message) => message.length > 0);
  if (!messages.length) return "Unavailable";
  const summary = messages.slice(0, 2).join(" | ");
  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary;
}

function extractUserDataCaptured(
  detail: ElevenLabsAnalysisConversationDetail | null,
  turns: ElevenLabsAnalysisTranscriptTurn[] | undefined,
) {
  const captures: string[] = [];
  const seen = new Set<string>();
  const summaryText = (detail?.transcript_summary || "").trim();

  const addCapture = (key: string, value: string) => {
    if (!value.trim() || seen.has(key)) return;
    seen.add(key);
    captures.push(value.trim());
  };

  const recordName = (name: string, context: string) => {
    const cleaned = name.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.length < 2) return;
    addCapture(`name:${cleaned.toLowerCase()}`, `Name: ${cleaned} (context: "${context}")`);
  };

  const recordNumber = (numberValue: string, context: string) => {
    const cleaned = numberValue.replace(/\s+/g, "").trim();
    if (cleaned.length < 6) return;
    addCapture(`number:${cleaned}`, `Number: ${cleaned} (context: "${context}")`);
  };

  if (summaryText) {
    const summaryContext = summaryText.length > 140 ? `${summaryText.slice(0, 137)}...` : summaryText;
    const quotedNames = summaryText.match(/"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)"/g) ?? [];
    quotedNames.forEach((quoted) => recordName(quoted.replace(/"/g, ""), summaryContext));
    const forName = summaryText.match(/\bfor\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
    if (forName?.[1]) recordName(forName[1], summaryContext);
    const summaryNumbers = summaryText.match(/(?:\+?\d[\d\s\-()]{5,}\d)/g) ?? [];
    summaryNumbers.forEach((raw) => recordNumber(raw, summaryContext));
  }

  for (const turn of turns ?? []) {
    const role = (turn.role || "").toLowerCase();
    if (role === "user") {
      const message = (turn.message || "").trim();
      if (!message) continue;
      const context = message.length > 120 ? `${message.slice(0, 117)}...` : message;

      const nameMatchers = [
        /\bmy name is\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3})/i,
        /\bi am\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3})/i,
        /\bthis is\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3})/i,
      ];
      for (const matcher of nameMatchers) {
        const result = message.match(matcher);
        const candidate = result?.[1]?.trim();
        if (!candidate) continue;
        recordName(candidate, context);
      }

      const numberMatches = message.match(/(?:\+?\d[\d\s\-()]{5,}\d)/g) ?? [];
      for (const raw of numberMatches) {
        recordNumber(raw, context);
      }
    }

    for (const resultEntry of turn.tool_results ?? []) {
      const resultRecord = asRecord(resultEntry);
      const parsedResult = asRecord(resultRecord?.result) || asRecord(parseJsonString(resultRecord?.result_value));
      if (!parsedResult) continue;

      const data = asRecord(parsedResult.data);
      const caseSelect = asRecord(data?.case_select);
      const customer =
        (typeof parsedResult.identified_customer === "string" && parsedResult.identified_customer) ||
        (typeof data?.identified_customer === "string" && data.identified_customer) ||
        (typeof caseSelect?.identified_customer === "string" && caseSelect.identified_customer) ||
        null;
      if (customer) {
        recordName(customer, `tool result: ${String(resultRecord?.tool_name ?? "workflow")}`);
      }

      const identifierValue = typeof caseSelect?.identifier_value === "string" ? caseSelect.identifier_value : null;
      if (identifierValue) {
        const matches = identifierValue.match(/(?:\+?\d[\d\s\-()]{5,}\d)/g) ?? [];
        matches.forEach((raw) => recordNumber(raw, `tool result: ${String(resultRecord?.tool_name ?? "workflow")}`));
      }

      const jobCards = asArray(data?.job_cards);
      if (jobCards.length) {
        const firstCard = asRecord(jobCards[0]);
        const cardNo = typeof firstCard?.job_card_no === "string" ? firstCard.job_card_no : null;
        if (cardNo) {
          addCapture(`job:${cardNo}`, `Job card: ${cardNo} (context: tool result)`);
        }
      }
    }
  }
  return captures.slice(0, 6);
}

function normalizeToolCall(entry: unknown, source: string, index: number): WorkflowCall | null {
  const record = asRecord(entry);
  if (!record) return null;
  const id = String(record.id ?? record.call_id ?? `${source}-${index}`);
  const name = String(record.tool_name ?? record.tool ?? record.name ?? "unknown_tool");
  const status = String(record.status ?? record.result_status ?? record.state ?? "unknown");
  const startedAt = toNumberOrNull(record.started_at_unix_secs ?? record.started_at ?? record.start_ts);
  const endedAt = toNumberOrNull(record.ended_at_unix_secs ?? record.finished_at ?? record.end_ts);
  const explicitLatency = toNumberOrNull(record.latency_ms ?? record.duration_ms);
  const latencyMs = explicitLatency ?? (startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : null);
  const errorValue = record.error ?? record.error_message ?? record.failure_reason;
  const error = errorValue == null ? null : String(errorValue);
  return {
    id,
    name,
    status,
    source,
    latencyMs,
    startedAt,
    endedAt,
    input: record.input ?? record.arguments ?? record.request ?? null,
    output: record.output ?? record.response ?? record.result ?? null,
    error,
  };
}

function extractWorkflowCalls(detail: ElevenLabsAnalysisConversationDetail | null): WorkflowCall[] {
  if (!detail) return [];

  const buckets: Array<{ source: string; entries: unknown[] }> = [];
  const analysis = asRecord(detail.analysis);
  const metadata = asRecord(detail.metadata);
  const clientData = asRecord(detail.client_data);

  buckets.push({ source: "analysis.tool_calls", entries: asArray(analysis?.tool_calls) });
  buckets.push({ source: "analysis.steps", entries: asArray(analysis?.steps) });
  buckets.push({ source: "metadata.tool_calls", entries: asArray(metadata?.tool_calls) });
  buckets.push({ source: "metadata.workflow.tool_calls", entries: asArray(asRecord(metadata?.workflow)?.tool_calls) });
  buckets.push({ source: "client_data.tool_calls", entries: asArray(clientData?.tool_calls) });

  const normalized: WorkflowCall[] = [];
  for (const bucket of buckets) {
    bucket.entries.forEach((entry, index) => {
      const direct = normalizeToolCall(entry, bucket.source, index);
      if (direct && direct.name !== "unknown_tool") {
        normalized.push(direct);
        return;
      }
      const nestedCalls = asArray(asRecord(entry)?.tool_calls);
      nestedCalls.forEach((nested, nestedIndex) => {
        const child = normalizeToolCall(nested, `${bucket.source}.nested`, nestedIndex);
        if (child && child.name !== "unknown_tool") {
          normalized.push(child);
        }
      });
    });
  }

  return normalized.sort((a, b) => {
    const left = a.startedAt ?? 0;
    const right = b.startedAt ?? 0;
    return left - right;
  });
}

function formatDateFromUnix(unix: number | null | undefined) {
  if (!unix) return "Unavailable";
  return new Date(unix * 1000).toLocaleString();
}

function formatDuration(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || seconds < 0) return "Unavailable";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function csvValue(value: unknown) {
  if (value == null) return "\"\"";
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function downloadCsv(filename: string, headers: string[], rows: Array<Record<string, unknown>>) {
  const headerLine = headers.map((header) => csvValue(header)).join(",");
  const dataLines = rows.map((row) => headers.map((header) => csvValue(row[header])).join(","));
  const csv = [headerLine, ...dataLines].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function statusBadge(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "done" || normalized === "success") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (normalized === "failed" || normalized === "failure") return "border-rose-200 bg-rose-50 text-rose-700";
  if (normalized === "processing" || normalized === "in-progress") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-100 text-slate-600";
}

export default function ElevenLabsAnalysisPage() {
  const navigate = useNavigate();
  const { conversationId } = useParams<{ conversationId?: string }>();
  const [tab, setTab] = useState<TabKey>("overview");
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [rows, setRows] = useState<ElevenLabsAnalysisConversationSummary[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("date_desc");
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [enrichmentById, setEnrichmentById] = useState<Record<string, ConversationEnrichment>>({});
  const [panelOpen, setPanelOpen] = useState(true);

  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ElevenLabsAnalysisConversationDetail | null>(null);
  const [transcript, setTranscript] = useState<ElevenLabsAnalysisTranscript | null>(null);
  const workflowCalls = useMemo(() => extractWorkflowCalls(detail), [detail]);
  const workflowFlow = useMemo(() => buildWorkflowFlow(transcript?.turns), [transcript?.turns]);
  const workflowSuccessCount = useMemo(
    () => workflowCalls.filter((call) => ["success", "done", "completed", "ok"].includes(call.status.toLowerCase())).length,
    [workflowCalls],
  );
  const workflowFailureCount = useMemo(
    () => workflowCalls.filter((call) => ["failed", "failure", "error"].includes(call.status.toLowerCase())).length,
    [workflowCalls],
  );

  const audioUrl = useMemo(() => (conversationId ? buildElevenLabsAnalysisAudioUrl(conversationId) : null), [conversationId]);
  const currentCursor = pageCursors[pageIndex] ?? null;
  const sortedRows = useMemo(() => {
    const statusWeight = (value: string) => {
      const normalized = value.toLowerCase();
      if (normalized === "failed" || normalized === "failure") return 0;
      if (normalized === "processing" || normalized === "in-progress") return 1;
      if (normalized === "done" || normalized === "success") return 2;
      return 3;
    };
    const list = [...rows];
    list.sort((left, right) => {
      if (sortBy === "status_asc") {
        const statusDelta = statusWeight(left.status) - statusWeight(right.status);
        if (statusDelta !== 0) return statusDelta;
      }
      const leftDate = left.started_at_unix_secs ?? 0;
      const rightDate = right.started_at_unix_secs ?? 0;
      return rightDate - leftDate;
    });
    return list;
  }, [rows, sortBy]);
  const selectedConversationIndex = useMemo(
    () => sortedRows.findIndex((row) => row.id === conversationId),
    [sortedRows, conversationId],
  );
  const hasPreviousConversation = selectedConversationIndex > 0;
  const hasNextConversation = selectedConversationIndex >= 0 && selectedConversationIndex < sortedRows.length - 1;

  async function enrichConversations(items: ElevenLabsAnalysisConversationSummary[]) {
    const ids = items.map((item) => item.id).filter(Boolean);
    if (!ids.length) return;
    setEnrichmentById((previous) => {
      const next = { ...previous };
      for (const item of items) {
        next[item.id] = {
          summary: previous[item.id]?.summary || item.title || "Loading transcript summary...",
          userDataCaptured: previous[item.id]?.userDataCaptured || [],
          callerNumber: previous[item.id]?.callerNumber || item.user_id || null,
          loading: true,
          error: null,
        };
      }
      return next;
    });

    const chunkSize = 5;
    for (let index = 0; index < items.length; index += chunkSize) {
      const chunk = items.slice(index, index + chunkSize);
      await Promise.all(
        chunk.map(async (item) => {
          try {
            const [detailData, transcriptData] = await Promise.all([
              fetchElevenLabsAnalysisConversation(item.id),
              fetchElevenLabsAnalysisTranscript(item.id),
            ]);
            const summary =
              detailData.transcript_summary ||
              detailData.call_summary_title ||
              summarizeTranscript(transcriptData.turns) ||
              item.title ||
              "Unavailable";
            const userDataCaptured = extractUserDataCaptured(detailData, transcriptData.turns);
            const callerNumberFromCapture = userDataCaptured.find((entry) => entry.startsWith("Number:"))?.replace(/^Number:\s*/i, "").split(" (context:")[0] ?? null;
            setEnrichmentById((previous) => ({
              ...previous,
              [item.id]: {
                summary,
                userDataCaptured,
                callerNumber: detailData.user_id || item.user_id || callerNumberFromCapture,
                loading: false,
                error: null,
              },
            }));
          } catch (error) {
            setEnrichmentById((previous) => ({
              ...previous,
              [item.id]: {
                summary: previous[item.id]?.summary || item.title || "Unavailable",
                userDataCaptured: previous[item.id]?.userDataCaptured || [],
                callerNumber: previous[item.id]?.callerNumber || item.user_id || null,
                loading: false,
                error: error instanceof Error ? error.message : String(error),
              },
            }));
          }
        }),
      );
    }
  }

  async function refreshList(cursorOverride?: string | null) {
    setLoadingList(true);
    setListError(null);
    try {
      const health = await fetchElevenLabsAnalysisHealth().catch(() => null);
      if (health && !health.ready) {
        setWarning("Call analysis source is currently unavailable. Please retry shortly.");
      } else {
        setWarning(null);
      }
      const data = await fetchElevenLabsAnalysisConversations({
        limit: PAGE_SIZE,
        cursor: cursorOverride ?? currentCursor,
        search: search.trim() || null,
        status: status || null,
        date_after_unix: dateAfter ? Math.floor(new Date(`${dateAfter}T00:00:00`).getTime() / 1000) : null,
        date_before_unix: dateBefore ? Math.floor(new Date(`${dateBefore}T23:59:59`).getTime() / 1000) : null,
      });
      const listItems = data.items ?? [];
      setRows(listItems);
      setNextCursor(data.next_cursor ?? null);
      setHasMore(Boolean(data.has_more && data.next_cursor));
      void enrichConversations(listItems);
      if (!data.upstream_ready) {
        setWarning("Call analysis source is currently unavailable. Please retry shortly.");
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setRows([]);
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    void refreshList(currentCursor);
  }, [pageIndex]);

  useEffect(() => {
    const selectedConversationId = conversationId;
    if (!selectedConversationId) {
      setDetail(null);
      setTranscript(null);
      setDetailError(null);
      return;
    }
    setPanelOpen(true);
    const id = selectedConversationId;
    async function loadDetail() {
      setDetailLoading(true);
      setDetailError(null);
      try {
        const [detailData, transcriptData] = await Promise.all([
          fetchElevenLabsAnalysisConversation(id),
          fetchElevenLabsAnalysisTranscript(id),
        ]);
        setDetail(detailData);
        setTranscript(transcriptData);
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : String(err));
      } finally {
        setDetailLoading(false);
      }
    }
    void loadDetail();
  }, [conversationId]);

  async function exportAllToCsv() {
    if (exportingCsv) return;
    setExportingCsv(true);
    setWarning(null);
    setListError(null);
    try {
      const collected: ElevenLabsAnalysisConversationSummary[] = [];
      let cursor: string | null = null;
      let hasNextPage = true;
      let guard = 0;

      while (hasNextPage) {
        const page = await fetchElevenLabsAnalysisConversations({
          limit: PAGE_SIZE,
          cursor,
          search: search.trim() || null,
          status: status || null,
          date_after_unix: dateAfter ? Math.floor(new Date(`${dateAfter}T00:00:00`).getTime() / 1000) : null,
          date_before_unix: dateBefore ? Math.floor(new Date(`${dateBefore}T23:59:59`).getTime() / 1000) : null,
        });
        collected.push(...(page.items ?? []));
        hasNextPage = Boolean(page.has_more && page.next_cursor);
        cursor = page.next_cursor ?? null;
        guard += 1;
        if (guard > 500) {
          throw new Error("Export aborted because pagination exceeded safe limits.");
        }
      }

      const rowsForExport = await Promise.all(
        collected.map(async (summary) => {
          try {
            const [detailData, transcriptData] = await Promise.all([
              fetchElevenLabsAnalysisConversation(summary.id),
              fetchElevenLabsAnalysisTranscript(summary.id),
            ]);
            const capturedUserData = extractUserDataCaptured(detailData, transcriptData.turns);
            const workflowCallCount = extractWorkflowCalls(detailData).length;
            return {
              id: summary.id,
              title: summary.title,
              status: summary.status,
              call_successful: summary.call_successful,
              started_at_unix_secs: summary.started_at_unix_secs,
              started_at_iso: summary.started_at_unix_secs ? new Date(summary.started_at_unix_secs * 1000).toISOString() : "",
              duration_seconds: summary.duration_seconds,
              message_count: summary.message_count,
              user_id: summary.user_id,
              branch_id: summary.branch_id,
              main_language: summary.main_language,
              channel: summary.channel,
              direction: summary.direction,
              rating: summary.rating,
              agent_id: summary.agent_id,
              agent_name: summary.agent_name,
              environment: detailData.environment,
              call_status: detailData.call_status,
              call_summary_title: detailData.call_summary_title,
              transcript_summary: detailData.transcript_summary || summarizeTranscript(transcriptData.turns),
              termination_reason: detailData.termination_reason,
              has_audio: detailData.has_audio,
              has_user_audio: detailData.has_user_audio,
              has_response_audio: detailData.has_response_audio,
              cost: detailData.cost,
              credits_llm: detailData.credits_llm,
              llm_cost: detailData.llm_cost,
              user_data_captured: capturedUserData.join(" | "),
              workflow_call_count: workflowCallCount,
              transcript_turn_count: transcriptData.turn_count,
              metadata_json: detailData.metadata,
              analysis_json: detailData.analysis,
              client_data_json: detailData.client_data,
              tag_ids_json: detailData.tag_ids,
              visited_agents_json: detailData.visited_agents,
              export_error: "",
            };
          } catch (error) {
            return {
              id: summary.id,
              title: summary.title,
              status: summary.status,
              call_successful: summary.call_successful,
              started_at_unix_secs: summary.started_at_unix_secs,
              started_at_iso: summary.started_at_unix_secs ? new Date(summary.started_at_unix_secs * 1000).toISOString() : "",
              duration_seconds: summary.duration_seconds,
              message_count: summary.message_count,
              user_id: summary.user_id,
              branch_id: summary.branch_id,
              main_language: summary.main_language,
              channel: summary.channel,
              direction: summary.direction,
              rating: summary.rating,
              agent_id: summary.agent_id,
              agent_name: summary.agent_name,
              environment: "",
              call_status: "",
              call_summary_title: "",
              transcript_summary: "",
              termination_reason: "",
              has_audio: "",
              has_user_audio: "",
              has_response_audio: "",
              cost: "",
              credits_llm: "",
              llm_cost: "",
              user_data_captured: "",
              workflow_call_count: "",
              transcript_turn_count: "",
              metadata_json: "",
              analysis_json: "",
              client_data_json: "",
              tag_ids_json: "",
              visited_agents_json: "",
              export_error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );

      const headers = [
        "id",
        "title",
        "status",
        "call_successful",
        "started_at_unix_secs",
        "started_at_iso",
        "duration_seconds",
        "message_count",
        "user_id",
        "branch_id",
        "main_language",
        "channel",
        "direction",
        "rating",
        "agent_id",
        "agent_name",
        "environment",
        "call_status",
        "call_summary_title",
        "transcript_summary",
        "termination_reason",
        "has_audio",
        "has_user_audio",
        "has_response_audio",
        "cost",
        "credits_llm",
        "llm_cost",
        "user_data_captured",
        "workflow_call_count",
        "transcript_turn_count",
        "metadata_json",
        "analysis_json",
        "client_data_json",
        "tag_ids_json",
        "visited_agents_json",
        "export_error",
      ];
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadCsv(`call-analysis-export-${timestamp}.csv`, headers, rowsForExport);
      setWarning(`Exported ${rowsForExport.length} conversations to CSV.`);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setExportingCsv(false);
    }
  }

  return (
    <div className="analysis-page space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-3">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Analysis</p>
        <h2 className="mt-1 text-[1rem] font-semibold text-slate-900">Call Analysis</h2>
        <div className="analysis-command-bar mt-3 grid gap-2 md:grid-cols-7">
          <input className="ghost-input md:col-span-2" placeholder="Search conversations..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="ghost-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All status</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="unknown">Unknown</option>
          </select>
          <select className="ghost-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortOption)}>
            <option value="date_desc">Order: Date</option>
            <option value="status_asc">Order: Status</option>
          </select>
          <input className="ghost-input" type="date" value={dateAfter} onChange={(e) => setDateAfter(e.target.value)} />
          <input className="ghost-input" type="date" value={dateBefore} onChange={(e) => setDateBefore(e.target.value)} />
          <button
            className="ghost-btn-primary"
            type="button"
            onClick={() => {
              setPageCursors([null]);
              setPageIndex(0);
              void refreshList(null);
            }}
          >
            Refresh
          </button>
        </div>
        {warning && <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.74rem] text-amber-700">{warning}</div>}
        {listError && <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[0.74rem] text-rose-700">{listError}</div>}
      </section>

      <div className="relative">
        <section className="glass rounded-xl border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button type="button" className="ghost-btn" onClick={() => void exportAllToCsv()} disabled={exportingCsv || loadingList}>
                {exportingCsv ? "Exporting..." : "EXPORT"}
              </button>
              <h3 className="text-[0.84rem] font-semibold text-slate-900">Conversations</h3>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-slate-600">
                {loadingList ? "Loading" : `${rows.length} rows`}
              </span>
              <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-slate-600">
                Page {pageIndex + 1}
              </span>
            </div>
          </div>
          <div className="mb-2 flex items-center justify-end gap-2">
            <button
              type="button"
              className="ghost-btn"
              disabled={pageIndex === 0 || loadingList}
              onClick={() => {
                if (pageIndex === 0) return;
                setPageIndex((current) => Math.max(0, current - 1));
              }}
            >
              Backward
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={!hasMore || !nextCursor || loadingList}
              onClick={() => {
                if (!nextCursor) return;
                setPageCursors((previous) => {
                  const copy = previous.slice(0, pageIndex + 1);
                  copy[pageIndex + 1] = nextCursor;
                  return copy;
                });
                setPageIndex((current) => current + 1);
              }}
            >
              Next page
            </button>
          </div>
          <div className="ghost-scroll max-h-[560px] overflow-auto rounded-lg border border-slate-200 bg-white/85">
            <table className="min-w-full text-left text-[0.74rem]">
              <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">TITLE</th>
                  <th className="px-3 py-2 font-semibold">Caller number</th>
                  <th className="px-3 py-2 font-semibold">Call time</th>
                  <th className="px-3 py-2 font-semibold">Transcript summary</th>
                  <th className="px-3 py-2 font-semibold">User data captured</th>
                  <th className="px-3 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => (
                  <tr
                    key={row.id}
                    className={`cursor-pointer border-b border-slate-100 last:border-b-0 ${conversationId === row.id ? "bg-orange-50/60" : "hover:bg-slate-50"}`}
                    onClick={() => navigate(`/analysis/call-analysis/${row.id}`)}
                  >
                    <td className="px-3 py-2 text-slate-800">
                      <div className="font-medium">{row.title || "Untitled conversation"}</div>
                      <div className="text-[0.67rem] text-slate-500">{row.id}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-700">{enrichmentById[row.id]?.callerNumber || row.user_id || "Unavailable"}</td>
                    <td className="px-3 py-2 text-slate-700">{formatDuration(row.duration_seconds)}</td>
                    <td className="px-3 py-2 text-slate-700">
                      <div className="max-w-[360px] whitespace-normal break-words">
                        {enrichmentById[row.id]?.loading ? "Summarising..." : (enrichmentById[row.id]?.summary || row.title || "Unavailable")}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      <div className="max-w-[360px] space-y-1 whitespace-normal break-words text-[0.7rem]">
                        {enrichmentById[row.id]?.loading && <div>Capturing...</div>}
                        {!enrichmentById[row.id]?.loading && enrichmentById[row.id]?.userDataCaptured?.length
                          ? enrichmentById[row.id].userDataCaptured.map((entry) => <div key={`${row.id}-${entry}`}>{entry}</div>)
                          : null}
                        {!enrichmentById[row.id]?.loading && !enrichmentById[row.id]?.userDataCaptured?.length && <div>Unavailable</div>}
                        {enrichmentById[row.id]?.error && <div className="text-rose-600">Capture partial ({enrichmentById[row.id]?.error})</div>}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{formatDateFromUnix(row.started_at_unix_secs)}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] ${statusBadge(row.status)}`}>
                        {row.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {!loadingList && rows.length === 0 && (
                  <tr>
                    <td className="px-3 py-3 text-slate-500" colSpan={7}>
                      No conversations available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <AnimatePresence>
          {conversationId && panelOpen && (
            <motion.button
              key="analysis-panel-backdrop"
              type="button"
              aria-label="Close conversation panel"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22 }}
              className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]"
              onClick={() => setPanelOpen(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {conversationId && panelOpen && (
            <motion.aside
              key={`analysis-panel-${conversationId}`}
              initial={{ x: "100%", opacity: 0.82 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "100%", opacity: 0.82 }}
              transition={PANEL_SPRING}
              className="glass-popup fixed right-0 top-1/2 z-50 h-[84vh] w-[min(760px,96vw)] -translate-y-1/2 overflow-hidden rounded-l-3xl border-l border-white/60 border-r-0 shadow-[0_20px_60px_rgba(15,23,42,0.20)]"
            >
              <div className="pointer-events-none absolute -right-20 top-2 h-52 w-52 rounded-full bg-orange-200/25 blur-3xl" />
              <div className="pointer-events-none absolute -left-24 bottom-[-5rem] h-64 w-64 rounded-full bg-sky-200/20 blur-3xl" />
              <div className="flex items-center justify-between border-b border-white/40 px-4 py-3">
                <div>
                  <p className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-slate-500">Conversation Panel</p>
                  <p className="text-[0.8rem] font-semibold text-slate-900">{detail?.title || detail?.call_summary_title || "Call Analysis"}</p>
                </div>
                <div className="flex items-center gap-2">
                  <motion.button
                    whileHover={{ y: -1, scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="ghost-btn border-slate-300/90 bg-white/70 transition hover:border-ghost-orange hover:bg-white hover:shadow-md"
                    type="button"
                    disabled={!hasPreviousConversation}
                    onClick={() => {
                      if (!hasPreviousConversation) return;
                      const prev = sortedRows[selectedConversationIndex - 1];
                      if (prev) navigate(`/analysis/call-analysis/${prev.id}`);
                    }}
                  >
                    Prev
                  </motion.button>
                  <motion.button
                    whileHover={{ y: -1, scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="ghost-btn border-slate-300/90 bg-white/70 transition hover:border-ghost-orange hover:bg-white hover:shadow-md"
                    type="button"
                    disabled={!hasNextConversation}
                    onClick={() => {
                      if (!hasNextConversation) return;
                      const next = sortedRows[selectedConversationIndex + 1];
                      if (next) navigate(`/analysis/call-analysis/${next.id}`);
                    }}
                  >
                    Next
                  </motion.button>
                  <motion.button
                    whileHover={{ y: -1, scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className="ghost-btn border-slate-300/90 bg-white/70 transition hover:border-ghost-orange hover:bg-white hover:shadow-md"
                    type="button"
                    onClick={() => setPanelOpen(false)}
                  >
                    Retract
                  </motion.button>
                  <motion.button whileHover={{ y: -1, scale: 1.02 }} whileTap={{ scale: 0.98 }} className="ghost-btn transition hover:shadow-md" type="button" onClick={() => navigate("/analysis/call-analysis")}>
                    Close
                  </motion.button>
                </div>
              </div>

              <div className="ghost-scroll relative h-[calc(100%-4.2rem)] overflow-auto p-3">
                <div className="space-y-3">
              {detailLoading && <p className="text-[0.75rem] text-slate-500">Loading conversation detail...</p>}
              {detailError && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[0.74rem] text-rose-700">{detailError}</div>}
              {detail && (
                <>
                  <div>
                    <h3 className="text-[0.9rem] font-semibold text-slate-900">{detail.title || detail.call_summary_title || "Conversation detail"}</h3>
                    <p className="text-[0.68rem] text-slate-500">{detail.id}</p>
                  </div>

                  <div className="rounded-lg border border-white/60 bg-white/36 p-2 backdrop-blur-md">
                    {detail.has_audio && audioUrl ? (
                      <audio controls className="w-full" src={audioUrl}>
                        Your browser does not support audio playback.
                      </audio>
                    ) : (
                      <div className="text-[0.72rem] text-slate-500">Audio unavailable for this conversation.</div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button className={`ghost-btn ${tab === "overview" ? "border-ghost-orange text-ghost-orange" : ""}`} onClick={() => setTab("overview")}>
                      Overview
                    </button>
                    <button className={`ghost-btn ${tab === "workflow" ? "border-ghost-orange text-ghost-orange" : ""}`} onClick={() => setTab("workflow")}>
                      Workflow
                    </button>
                    <button className={`ghost-btn ${tab === "transcription" ? "border-ghost-orange text-ghost-orange" : ""}`} onClick={() => setTab("transcription")}>
                      Transcription
                    </button>
                    <button className={`ghost-btn ${tab === "client_data" ? "border-ghost-orange text-ghost-orange" : ""}`} onClick={() => setTab("client_data")}>
                      Client data
                    </button>
                    <button className={`ghost-btn ${tab === "phone_call" ? "border-ghost-orange text-ghost-orange" : ""}`} onClick={() => setTab("phone_call")}>
                      Phone call
                    </button>
                  </div>

                  {tab === "overview" && (
                    <div className="space-y-2 rounded-lg border border-white/60 bg-white/36 p-3 text-[0.74rem] text-slate-700 backdrop-blur-md">
                      <div>Date: {formatDateFromUnix(detail.started_at_unix_secs)}</div>
                      <div>Environment: {detail.environment || "Unavailable"}</div>
                      <div>Duration: {formatDuration(detail.duration_seconds)}</div>
                      <div>Call status: {detail.call_status || detail.status}</div>
                      <div>How call ended: {detail.termination_reason || "Unavailable"}</div>
                      <div>User ID: {detail.user_id || "Unavailable"}</div>
                      <div>Credits (LLM): {detail.credits_llm ?? "Unavailable"}</div>
                      <div>LLM cost: {detail.llm_cost ?? "Unavailable"}</div>
                    </div>
                  )}

                  {tab === "workflow" && (
                    <div className="space-y-3">
                      <div className="glass-panel rounded-xl border border-white/40 bg-white/40 p-3 backdrop-blur-md">
                        <div className="flex flex-wrap items-center gap-2 text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-slate-600">
                          <span className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5">Flow steps: {workflowFlow.length}</span>
                          <span className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5">Calls: {workflowCalls.length}</span>
                          <span className="rounded-full border border-emerald-200 bg-emerald-50/80 px-2 py-0.5 text-emerald-700">Success: {workflowSuccessCount}</span>
                          <span className="rounded-full border border-rose-200 bg-rose-50/80 px-2 py-0.5 text-rose-700">Failure: {workflowFailureCount}</span>
                        </div>
                        <p className="mt-2 text-[0.7rem] text-slate-500">Clear execution flow with routing, tool dispatch, result payloads, and code executed.</p>
                      </div>

                      {workflowFlow.length === 0 && workflowCalls.length === 0 && (
                        <div className="glass-panel rounded-xl border border-white/40 bg-white/40 p-3 text-[0.74rem] text-slate-600 backdrop-blur-md">
                          No tool-calling events were found in this conversation payload.
                        </div>
                      )}

                      {workflowFlow.length > 0 && (
                        <div className="space-y-2">
                          {workflowFlow.map((step) => (
                            <div key={step.id} className="glass-panel rounded-xl border border-white/50 bg-white/55 p-3 backdrop-blur-lg">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <p className="text-[0.76rem] font-semibold text-slate-900">{step.title}</p>
                                  <p className="text-[0.68rem] text-slate-600">{step.subtitle}</p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 text-[0.62rem] font-semibold uppercase tracking-[0.1em] text-slate-600">
                                  <span className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5">{step.timeLabel}</span>
                                  {step.latency && <span className="rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-orange-700">{step.latency}</span>}
                                  {step.status && <span className={`rounded-full border px-2 py-0.5 ${statusBadge(step.status)}`}>{step.status}</span>}
                                </div>
                              </div>
                              {step.codeExecuted && (
                                <div className="mt-2 rounded-lg border border-slate-200 bg-white/85 px-2 py-1 text-[0.66rem] text-slate-700">
                                  Code executed: <span className="font-semibold">{step.codeExecuted}</span>
                                </div>
                              )}
                              {(Boolean(step.requestPayload) || Boolean(step.resultPayload)) && (
                                <div className="mt-2 grid gap-2 md:grid-cols-2">
                                  {Boolean(step.requestPayload) && (
                                    <details className="rounded-lg border border-slate-200 bg-white/80 p-2">
                                      <summary className="cursor-pointer text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-slate-600">Request</summary>
                                      <pre className="ghost-scroll mt-1 max-h-36 overflow-auto text-[0.64rem] text-slate-700">{summarizeJson(step.requestPayload)}</pre>
                                    </details>
                                  )}
                                  {Boolean(step.resultPayload) && (
                                    <details className="rounded-lg border border-slate-200 bg-white/80 p-2">
                                      <summary className="cursor-pointer text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-slate-600">Result</summary>
                                      <pre className="ghost-scroll mt-1 max-h-36 overflow-auto text-[0.64rem] text-slate-700">{summarizeJson(step.resultPayload)}</pre>
                                    </details>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {workflowCalls.map((call) => (
                        <div key={call.id} className="glass-panel rounded-xl border border-white/50 bg-white/50 p-3 backdrop-blur-lg">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="text-[0.76rem] font-semibold text-slate-900">{call.name}</p>
                              <p className="text-[0.64rem] text-slate-500">{call.source}</p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-[0.62rem] font-semibold uppercase tracking-[0.1em]">
                              <span className={`rounded-full border px-2 py-0.5 ${statusBadge(call.status)}`}>{call.status}</span>
                              <span className="rounded-full border border-slate-200 bg-white/80 px-2 py-0.5 text-slate-600">
                                {call.latencyMs != null ? `${call.latencyMs} ms` : "latency n/a"}
                              </span>
                            </div>
                          </div>

                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <div className="rounded-lg border border-white/50 bg-white/60 p-2">
                              <p className="mb-1 text-[0.62rem] font-semibold uppercase tracking-[0.1em] text-slate-500">Input</p>
                              <pre className="ghost-scroll max-h-32 overflow-auto text-[0.66rem] text-slate-700">{summarizeJson(call.input)}</pre>
                            </div>
                            <div className="rounded-lg border border-white/50 bg-white/60 p-2">
                              <p className="mb-1 text-[0.62rem] font-semibold uppercase tracking-[0.1em] text-slate-500">Output</p>
                              <pre className="ghost-scroll max-h-32 overflow-auto text-[0.66rem] text-slate-700">{summarizeJson(call.output)}</pre>
                            </div>
                          </div>

                          {call.error && (
                            <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50/70 px-2 py-1 text-[0.68rem] text-rose-700">{call.error}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {tab === "transcription" && (
                    <div className="ghost-scroll max-h-[360px] space-y-2 overflow-auto rounded-lg border border-white/60 bg-white/32 p-3 backdrop-blur-md">
                      {transcript?.turns?.length ? (
                        transcript.turns.map((turn) => (
                          <div key={turn.id} className="rounded-lg border border-white/60 bg-white/34 p-2 text-[0.72rem] backdrop-blur-md">
                            <div className="mb-1 flex items-center justify-between text-[0.65rem] uppercase tracking-[0.12em] text-slate-500">
                              <span>{turn.role}</span>
                              <span>{typeof turn.start_time_seconds === "number" ? `${turn.start_time_seconds}s` : "n/a"}</span>
                            </div>
                            <div className="text-slate-800">{turn.message || "..."}</div>

                            <div className="mt-2 flex flex-wrap gap-2 text-[0.64rem]">
                              {readMetricLatency(turn, "convai_asr_trailing_service_latency") && (
                                <span className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-sky-700">
                                  ASR {readMetricLatency(turn, "convai_asr_trailing_service_latency")}
                                </span>
                              )}
                              {readMetricLatency(turn, "convai_llm_service_ttfb") && (
                                <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-violet-700">
                                  LLM {readMetricLatency(turn, "convai_llm_service_ttfb")}
                                </span>
                              )}
                              {readMetricLatency(turn, "convai_tts_service_ttfb") && (
                                <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-amber-700">
                                  TTS {readMetricLatency(turn, "convai_tts_service_ttfb")}
                                </span>
                              )}
                              {readMetricLatency(turn, "convai_llm_tool_request_generation_latency") && (
                                <span className="rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-orange-700">
                                  Workflow route {readMetricLatency(turn, "convai_llm_tool_request_generation_latency")}
                                </span>
                              )}
                            </div>

                            {turn.tool_calls?.length > 0 && (
                              <div className="mt-2 space-y-2">
                                {turn.tool_calls.map((call, index) => {
                                  const record = asRecord(call);
                                  const toolName = String(record?.tool_name ?? "Tool dispatch");
                                  const toolType = String(record?.type ?? "tool");
                                  const params = parseJsonString(record?.params_as_json);
                                  const toolDetails = parseJsonString(record?.tool_details);
                                  return (
                                    <div key={`${turn.id}-call-${index}`} className="rounded-lg border border-orange-200 bg-orange-50/60 p-2">
                                      <div className="text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-orange-700">
                                        Tool dispatch: {toolName}
                                      </div>
                                      <div className="mt-1 text-[0.68rem] text-slate-700">Type: {toolType}</div>
                                      <details className="mt-1">
                                        <summary className="cursor-pointer text-[0.66rem] text-slate-600">Show request</summary>
                                        <pre className="ghost-scroll mt-1 max-h-40 overflow-auto rounded border border-slate-200 bg-white/80 p-2 text-[0.64rem] text-slate-700">
                                          {summarizeJson(params)}
                                        </pre>
                                      </details>
                                      {Boolean(toolDetails) && (
                                        <details className="mt-1">
                                          <summary className="cursor-pointer text-[0.66rem] text-slate-600">Show tool details</summary>
                                          <pre className="ghost-scroll mt-1 max-h-40 overflow-auto rounded border border-slate-200 bg-white/80 p-2 text-[0.64rem] text-slate-700">
                                            {summarizeJson(toolDetails)}
                                          </pre>
                                        </details>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {turn.tool_results?.length > 0 && (
                              <div className="mt-2 space-y-2">
                                {turn.tool_results.map((result, index) => {
                                  const record = asRecord(result);
                                  const toolName = String(record?.tool_name ?? "tool");
                                  const latency = formatLatencyMs(record?.tool_latency_secs);
                                  const hasError = Boolean(record?.is_error);
                                  const parsedResult = record?.result ?? parseJsonString(record?.result_value);
                                  return (
                                    <div
                                      key={`${turn.id}-result-${index}`}
                                      className={`rounded-lg border p-2 ${hasError ? "border-rose-200 bg-rose-50/60" : "border-emerald-200 bg-emerald-50/60"}`}
                                    >
                                      <div className="text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-slate-700">
                                        {hasError ? "Tool failed" : "Tool succeeded"}: {toolName}
                                      </div>
                                      {latency && <div className="mt-1 text-[0.68rem] text-slate-700">Result {latency}</div>}
                                      <details className="mt-1">
                                        <summary className="cursor-pointer text-[0.66rem] text-slate-600">Show result payload</summary>
                                        <pre className="ghost-scroll mt-1 max-h-48 overflow-auto rounded border border-slate-200 bg-white/80 p-2 text-[0.64rem] text-slate-700">
                                          {summarizeJson(parsedResult)}
                                        </pre>
                                      </details>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        ))
                      ) : (
                        <div className="text-[0.72rem] text-slate-500">Transcript unavailable.</div>
                      )}
                    </div>
                  )}

                  {tab === "client_data" && (
                    <pre className="ghost-scroll max-h-[320px] overflow-auto rounded-lg border border-slate-200 bg-slate-950 px-3 py-2 text-[0.68rem] text-slate-100">
                      {JSON.stringify(detail.client_data ?? {}, null, 2)}
                    </pre>
                  )}

                  {tab === "phone_call" && (
                    <pre className="ghost-scroll max-h-[320px] overflow-auto rounded-lg border border-slate-200 bg-slate-950 px-3 py-2 text-[0.68rem] text-slate-100">
                      {JSON.stringify((detail.metadata ?? {}).phone_call ?? {}, null, 2)}
                    </pre>
                  )}
                </>
              )}
            </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {conversationId && !panelOpen && (
              <motion.button
                key={`analysis-panel-handle-${conversationId}`}
                type="button"
                aria-label="Open conversation panel"
                initial={{ x: 60, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 60, opacity: 0 }}
                transition={PANEL_SPRING}
                whileHover={{ x: -3, scale: 1.03 }}
                whileTap={{ scale: 0.98 }}
                className="glass-chat fixed right-0 top-1/2 z-50 -translate-y-1/2 rounded-l-2xl border-r-0 px-3 py-4 text-[0.66rem] font-semibold uppercase tracking-[0.1em] text-slate-700 transition hover:text-slate-900"
                onClick={() => setPanelOpen(true)}
              >
                Open Panel
              </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
