/**
 * Typed API client for agent-runtime backend.
 * All requests go through /api/agent-runtime/* (Caddy proxy).
 */

const BASE = "/api/agent-runtime";

export type AgentRunStatus =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed";

export interface AgentRun {
  id: string;
  question: string;
  model: string;
  mode: string;
  status: AgentRunStatus;
  created_at: string;
  completed_at: string | null;
  summary: string | null;
  error: string | null;
  events: RunEvent[];
  artifacts: Artifact[];
}

export interface RunEvent {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  status: string | null;
  title: string | null;
  payload: Record<string, unknown> | null;
  visible: boolean;
  created_at: string;
}

export interface Artifact {
  id: string;
  run_id: string;
  path: string;
  name: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
  description: string;
  created_at: string;
}

export async function createRun(body: {
  question: string;
  model?: string;
  max_steps?: number;
}): Promise<{ run_id: string; status: string }> {
  const res = await fetch(`${BASE}/api/agent-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`createRun failed: ${res.status}`);
  return res.json();
}

export async function getRun(runId: string): Promise<AgentRun> {
  const res = await fetch(`${BASE}/api/agent-runs/${runId}`);
  if (!res.ok) throw new Error(`getRun failed: ${res.status}`);
  return res.json();
}

export async function submitApproval(
  runId: string,
  approvalId: string,
  decision: "allow_once" | "allow_always" | "reject"
): Promise<void> {
  const res = await fetch(
    `${BASE}/api/agent-runs/${runId}/approvals/${approvalId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    }
  );
  if (!res.ok) throw new Error(`submitApproval failed: ${res.status}`);
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/agent-runs/${runId}/cancel`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`cancelRun failed: ${res.status}`);
}

export function getArtifactUrl(runId: string, artifactId: string): string {
  return `${BASE}/api/agent-runs/${runId}/artifacts/${artifactId}`;
}

export function subscribeToRunEvents(
  runId: string,
  afterSeq: number,
  onEvent: (event: RunEvent) => void,
  onEnd: () => void
): () => void {
  const url = `${BASE}/api/agent-runs/${runId}/events/stream?after_seq=${afterSeq}`;
  const es = new EventSource(url);

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "stream.end") {
        onEnd();
        es.close();
        return;
      }
      onEvent(data as RunEvent);
    } catch {
      // ignore parse errors
    }
  };

  es.onerror = () => {
    es.close();
  };

  return () => es.close();
}
