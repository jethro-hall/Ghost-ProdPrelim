import React from "react";
import type { Artifact, RunEvent } from "./api";
import { getArtifactUrl } from "./api";

interface Props {
  event: RunEvent | null;
  runId: string;
  artifacts: Artifact[];
}

export const AgentDetailPane: React.FC<Props> = ({
  event,
  runId,
  artifacts,
}) => {
  if (!event) {
    return (
      <div
        style={{
          padding: 24,
          color: "#475569",
          fontFamily: "monospace",
          fontSize: 13,
        }}
      >
        Click any event row to inspect it.
      </div>
    );
  }

  const payload = event.payload || {};

  return (
    <div
      style={{
        fontFamily: "monospace",
        fontSize: 13,
        lineHeight: 1.6,
        padding: 16,
        height: "100%",
        overflowY: "auto",
        background: "#0f172a",
        color: "#e2e8f0",
      }}
    >
      {/* Header */}
      <div
        style={{
          marginBottom: 12,
          paddingBottom: 8,
          borderBottom: "1px solid #1e293b",
        }}
      >
        <div style={{ color: "#94a3b8", fontSize: 11 }}>
          seq {event.seq} · {event.type} ·{" "}
          {event.created_at
            ? new Date(event.created_at).toLocaleTimeString()
            : ""}
        </div>
        <div style={{ fontWeight: "bold", marginTop: 4 }}>
          {event.title || event.type}
        </div>
      </div>

      {/* Event-specific content */}
      {event.type === "agent.final" && (
        <Section label="Final Answer">
          <div
            style={{
              whiteSpace: "pre-wrap",
              color: "#86efac",
              background: "#1e3a2f",
              padding: 12,
              borderRadius: 6,
            }}
          >
            {String((payload as any).content || "")}
          </div>
        </Section>
      )}

      {event.type === "agent.plan.public" && (
        <Section label="Public Plan">
          <div style={{ whiteSpace: "pre-wrap", color: "#c4b5fd" }}>
            {String((payload as any).plan || "")}
          </div>
        </Section>
      )}

      {(event.type === "tool.call.started" ||
        event.type === "tool.call.completed" ||
        event.type === "tool.call.failed") && (
        <>
          <Section label="Tool">
            <code style={{ color: "#67e8f9" }}>
              {String((payload as any).tool_name || "")}
            </code>
          </Section>
          {(payload as any).args && (
            <Section label="Arguments">
              <pre
                style={{
                  background: "#1e293b",
                  padding: 10,
                  borderRadius: 6,
                  overflow: "auto",
                  fontSize: 11,
                  color: "#94a3b8",
                }}
              >
                {JSON.stringify((payload as any).args, null, 2)}
              </pre>
            </Section>
          )}
          {(payload as any).exit_code !== undefined && (
            <Section label="Exit code">
              <code
                style={{
                  color:
                    (payload as any).exit_code === 0 ? "#22c55e" : "#ef4444",
                }}
              >
                {(payload as any).exit_code}
              </code>
            </Section>
          )}
        </>
      )}

      {event.type === "artifact.created" && (
        <Section label="Artifact">
          <div style={{ marginBottom: 6 }}>
            <strong>{String((payload as any).name || "artifact")}</strong>
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11 }}>
            SHA-256: {String((payload as any).sha256 || "").slice(0, 16)}…
          </div>
          <div style={{ color: "#94a3b8", fontSize: 11 }}>
            Size: {Number((payload as any).size_bytes || 0).toLocaleString()} bytes
          </div>
          {(payload as any).description && (
            <div style={{ marginTop: 6, color: "#94a3b8" }}>
              {String((payload as any).description)}
            </div>
          )}
          {/* Download link */}
          {(payload as any).artifact_id && (
            <a
              href={getArtifactUrl(runId, String((payload as any).artifact_id))}
              target="_blank"
              rel="noreferrer"
              style={{
                display: "inline-block",
                marginTop: 8,
                padding: "4px 10px",
                background: "#0284c7",
                color: "#fff",
                borderRadius: 4,
                textDecoration: "none",
                fontSize: 12,
              }}
            >
              Download
            </a>
          )}
        </Section>
      )}

      {(event.type === "verification.failed" ||
        event.type === "verification.passed") && (
        <Section label="Verifier Report">
          <div
            style={{
              background:
                event.type === "verification.passed" ? "#1e3a2f" : "#3a1e1e",
              padding: 12,
              borderRadius: 6,
            }}
          >
            <div
              style={{
                fontWeight: "bold",
                color:
                  event.type === "verification.passed" ? "#22c55e" : "#ef4444",
                marginBottom: 8,
              }}
            >
              {event.type === "verification.passed" ? "PASS" : "FAIL"}
              {(payload as any).confidence !== undefined &&
                ` — confidence ${Number((payload as any).confidence).toFixed(2)}`}
            </div>
            {(payload as any).defects &&
              ((payload as any).defects as string[]).length > 0 && (
                <>
                  <div style={{ color: "#fca5a5", marginBottom: 4 }}>
                    Defects:
                  </div>
                  {((payload as any).defects as string[]).map((d, i) => (
                    <div key={i} style={{ color: "#fca5a5", fontSize: 11 }}>
                      • {d}
                    </div>
                  ))}
                </>
              )}
            {(payload as any).summary && (
              <div style={{ marginTop: 8, color: "#94a3b8", fontSize: 11 }}>
                {String((payload as any).summary)}
              </div>
            )}
          </div>
        </Section>
      )}

      {/* Raw payload for other events */}
      {![
        "agent.final",
        "agent.plan.public",
        "tool.call.started",
        "tool.call.completed",
        "tool.call.failed",
        "artifact.created",
        "verification.failed",
        "verification.passed",
      ].includes(event.type) && (
        <Section label="Payload">
          <pre
            style={{
              background: "#1e293b",
              padding: 10,
              borderRadius: 6,
              overflow: "auto",
              fontSize: 11,
              color: "#94a3b8",
            }}
          >
            {JSON.stringify(payload, null, 2)}
          </pre>
        </Section>
      )}

      {/* All artifacts */}
      {artifacts.length > 0 && (
        <Section label="Run Artifacts">
          {artifacts.map((a) => (
            <div
              key={a.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "4px 0",
                borderBottom: "1px solid #1e293b",
                fontSize: 12,
              }}
            >
              <span style={{ color: "#67e8f9" }}>{a.name}</span>
              <a
                href={getArtifactUrl(runId, a.id)}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#0ea5e9", fontSize: 11 }}
              >
                {(a.size_bytes / 1024).toFixed(1)}KB ↓
              </a>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
};

const Section: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div style={{ marginBottom: 16 }}>
    <div
      style={{
        fontSize: 10,
        fontWeight: "bold",
        color: "#475569",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        marginBottom: 6,
      }}
    >
      {label}
    </div>
    {children}
  </div>
);
