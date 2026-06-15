import React from "react";
import type { RunEvent } from "./api";
import { submitApproval } from "./api";

interface Props {
  event: RunEvent;
  runId: string;
  onDecision: () => void;
}

/**
 * Blocking approval modal — shown when approval.requested fires.
 * Overlays the UI and requires operator action before the run continues.
 */
export const ApprovalModal: React.FC<Props> = ({
  event,
  runId,
  onDecision,
}) => {
  const payload = event.payload || {};
  const toolName = String((payload as any).tool_name || "");
  const approvalId = String((payload as any).approval_id || "");
  const riskLevel = String((payload as any).risk_level || "medium");
  const args = (payload as any).args || {};

  const riskColor: Record<string, string> = {
    low: "#22c55e",
    medium: "#f59e0b",
    high: "#ef4444",
    critical: "#dc2626",
  };

  const handleDecision = async (
    decision: "allow_once" | "allow_always" | "reject"
  ) => {
    await submitApproval(runId, approvalId, decision);
    onDecision();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.8)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <div
        style={{
          background: "#1e293b",
          borderRadius: 12,
          padding: 28,
          maxWidth: 520,
          width: "90%",
          border: `1px solid ${riskColor[riskLevel] || "#475569"}`,
          fontFamily: "monospace",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 16,
          }}
        >
          <span
            style={{
              background: riskColor[riskLevel] || "#475569",
              color: "#fff",
              padding: "2px 8px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: "bold",
              textTransform: "uppercase",
            }}
          >
            {riskLevel} risk
          </span>
          <span
            style={{
              fontSize: 15,
              fontWeight: "bold",
              color: "#e2e8f0",
            }}
          >
            Approval Required
          </span>
        </div>

        {/* Tool info */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: "#94a3b8", fontSize: 11, marginBottom: 4 }}>
            TOOL
          </div>
          <code style={{ color: "#67e8f9", fontSize: 14 }}>{toolName}</code>
        </div>

        {/* Args */}
        {Object.keys(args).length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ color: "#94a3b8", fontSize: 11, marginBottom: 4 }}>
              ARGUMENTS
            </div>
            <pre
              style={{
                background: "#0f172a",
                padding: 10,
                borderRadius: 6,
                fontSize: 11,
                color: "#94a3b8",
                overflow: "auto",
                maxHeight: 200,
                margin: 0,
              }}
            >
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={() => handleDecision("reject")}
            style={{
              background: "#450a0a",
              color: "#fca5a5",
              border: "1px solid #ef4444",
              borderRadius: 6,
              padding: "8px 16px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Reject
          </button>
          <button
            onClick={() => handleDecision("allow_once")}
            style={{
              background: "#052e16",
              color: "#86efac",
              border: "1px solid #22c55e",
              borderRadius: 6,
              padding: "8px 16px",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
};
