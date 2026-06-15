import React, { useEffect, useRef, useState } from "react";
import type { RunEvent } from "./api";

// ── Event type metadata ───────────────────────────────────────────────────────

const EVENT_META: Record<
  string,
  { icon: string; label: string; color: string }
> = {
  "run.started":            { icon: "●", label: "Run started",        color: "#6366f1" },
  "agent.analyzing":        { icon: "~", label: "Studying request",    color: "#8b5cf6" },
  "agent.message.delta":    { icon: "▸", label: "Agent",               color: "#a78bfa" },
  "agent.plan.public":      { icon: "≡", label: "Plan",                color: "#7c3aed" },
  "agent.replanning":       { icon: "⟳", label: "Replanning",          color: "#f59e0b" },
  "tool.call.started":      { icon: "→", label: "Tool",                color: "#0ea5e9" },
  "tool.stdout.delta":      { icon: ">", label: "Output",              color: "#94a3b8" },
  "tool.call.completed":    { icon: "✓", label: "Completed",           color: "#22c55e" },
  "tool.call.failed":       { icon: "✗", label: "Error",               color: "#ef4444" },
  "artifact.created":       { icon: "⊕", label: "Artifact",            color: "#10b981" },
  "approval.requested":     { icon: "!", label: "Approval required",   color: "#f97316" },
  "verification.started":   { icon: "◈", label: "Verifier started",    color: "#6366f1" },
  "verification.failed":    { icon: "✗", label: "Verifier FAIL",       color: "#ef4444" },
  "verification.passed":    { icon: "◈", label: "Verifier PASS",       color: "#22c55e" },
  "agent.remediation.started": { icon: "⟳", label: "Remediating",     color: "#f59e0b" },
  "agent.final":            { icon: "★", label: "Final answer",        color: "#f59e0b" },
  "run.completed":          { icon: "●", label: "Done",                color: "#22c55e" },
};

function getEventMeta(type: string) {
  return (
    EVENT_META[type] || {
      icon: "·",
      label: type,
      color: "#64748b",
    }
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  events: RunEvent[];
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
  onApprove?: (approvalId: string, decision: "allow_once" | "reject") => void;
  isLive: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const AgentTimeline: React.FC<Props> = ({
  events,
  selectedEventId,
  onSelectEvent,
  onApprove,
  isLive,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (isLive && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events.length, isLive]);

  const visibleEvents = events.filter(
    (e) =>
      e.visible &&
      e.type !== "tool.stdout.delta" // stdout deltas shown inline, not as rows
  );

  return (
    <div
      style={{
        fontFamily: "monospace",
        fontSize: 13,
        lineHeight: 1.6,
        background: "#0f172a",
        color: "#e2e8f0",
        height: "100%",
        overflowY: "auto",
        padding: "12px 0",
      }}
    >
      {visibleEvents.length === 0 && (
        <div style={{ padding: "24px 16px", color: "#475569" }}>
          Waiting for run to start…
        </div>
      )}

      {visibleEvents.map((evt) => (
        <TimelineRow
          key={evt.id}
          event={evt}
          selected={evt.id === selectedEventId}
          onClick={() => onSelectEvent(evt.id)}
          onApprove={onApprove}
          stdout={getStdoutForTool(events, evt)}
        />
      ))}

      {isLive && (
        <div
          style={{
            padding: "8px 16px",
            color: "#475569",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span className="pulse-dot" />
          running…
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
};

// ── Row ───────────────────────────────────────────────────────────────────────

interface RowProps {
  event: RunEvent;
  selected: boolean;
  onClick: () => void;
  onApprove?: (approvalId: string, decision: "allow_once" | "reject") => void;
  stdout: string;
}

const TimelineRow: React.FC<RowProps> = ({
  event,
  selected,
  onClick,
  onApprove,
  stdout,
}) => {
  const meta = getEventMeta(event.type);
  const isApproval = event.type === "approval.requested";
  const isFinal = event.type === "agent.final";

  const payload = event.payload || {};
  const toolName = (payload as any).tool_name || "";
  const confidence = (payload as any).confidence;

  const displayTitle =
    event.title ||
    (toolName ? `${meta.label}: ${toolName}` : meta.label);

  const ts = event.created_at
    ? new Date(event.created_at).toLocaleTimeString()
    : "";

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        padding: "4px 16px",
        cursor: "pointer",
        background: selected ? "#1e293b" : "transparent",
        borderLeft: selected ? `3px solid ${meta.color}` : "3px solid transparent",
        transition: "background 0.1s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            color: meta.color,
            width: 12,
            textAlign: "center",
            flexShrink: 0,
          }}
        >
          {meta.icon}
        </span>
        <span style={{ color: meta.color, minWidth: 90, flexShrink: 0 }}>
          {meta.label}
        </span>
        <span style={{ color: "#94a3b8", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayTitle}
          {confidence !== undefined && ` (confidence ${Number(confidence).toFixed(2)})`}
        </span>
        <span style={{ color: "#475569", fontSize: 11 }}>{ts}</span>
      </div>

      {/* Inline stdout preview */}
      {stdout && (
        <div
          style={{
            margin: "2px 0 2px 20px",
            padding: "4px 8px",
            background: "#1e293b",
            borderRadius: 4,
            fontSize: 11,
            color: "#64748b",
            whiteSpace: "pre-wrap",
            maxHeight: 80,
            overflow: "hidden",
          }}
        >
          {stdout.slice(0, 300)}
          {stdout.length > 300 && "\n…"}
        </div>
      )}

      {/* Approval controls */}
      {isApproval && onApprove && (
        <div
          style={{ margin: "6px 0 4px 20px", display: "flex", gap: 8 }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() =>
              onApprove(
                (payload as any).approval_id,
                "allow_once"
              )
            }
            style={{
              background: "#22c55e",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Allow
          </button>
          <button
            onClick={() =>
              onApprove(
                (payload as any).approval_id,
                "reject"
              )
            }
            style={{
              background: "#ef4444",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Reject
          </button>
          <span style={{ color: "#f97316", fontSize: 11, alignSelf: "center" }}>
            {toolName && `${toolName} requires approval`}
          </span>
        </div>
      )}

      {/* Final answer inline preview */}
      {isFinal && (
        <div
          style={{
            margin: "6px 0 4px 20px",
            padding: "8px 12px",
            background: "#1e3a2f",
            borderRadius: 6,
            fontSize: 12,
            color: "#86efac",
            whiteSpace: "pre-wrap",
            maxHeight: 200,
            overflow: "auto",
          }}
        >
          {String((payload as any).content || "").slice(0, 600)}
          {String((payload as any).content || "").length > 600 && "\n…"}
        </div>
      )}
    </div>
  );
};

// ── Helper ────────────────────────────────────────────────────────────────────

function getStdoutForTool(events: RunEvent[], toolStartEvent: RunEvent): string {
  if (toolStartEvent.type !== "tool.call.started") return "";
  const callId = (toolStartEvent.payload as any)?.call_id;
  if (!callId) return "";
  const deltaEvents = events.filter(
    (e) =>
      e.type === "tool.stdout.delta" &&
      (e.payload as any)?.call_id === callId
  );
  return deltaEvents
    .map((e) => String((e.payload as any)?.text || ""))
    .join("")
    .slice(0, 300);
}
