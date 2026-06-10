import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import type { ChatApiMode, Connection, RequestedLane, RuntimeDefaults, Task } from "../api";
import * as ghostApi from "../api";
import BackgroundOrbs from "./BackgroundOrbs";
import FullScreenLoader from "./FullScreenLoader";
import GhostChatMirror from "./GhostChatMirror";
import Header from "./Header";
import AgentSimulationPanel from "./AgentSimulationPanel";
import RightPanel from "./RightPanel";
import Sidebar from "./Sidebar";

export const CONNECTIONS_UPDATED_EVENT = "ghostdash:connections-updated";

const pendingTask: Task = {
  id: "pending",
  task_type: "full_sync",
  status: "pending",
  current_step: "queued",
  progress: 0,
  error_message: null,
  steps: [
    { id: "queued", label: "Queued", done: false, active: true, status: "running" },
    { id: "parse_structure", label: "Parse Structure", done: false, active: false, status: "pending" },
    { id: "index_retrieval", label: "Index Retrieval", done: false, active: false, status: "pending" },
    { id: "finalize", label: "Finalize", done: false, active: false, status: "pending" },
  ],
  total_documents: 0,
  completed_documents: 0,
  failed_documents: 0,
  active_document_id: null,
  active_filename: null,
  documents: [],
};

export type AppOutletContext = {
  uploadFile: (f: File, corpus?: string, lane?: RequestedLane) => Promise<{ id: string }>;
  startSync: (corpus?: string) => Promise<void>;
  refreshConnections: () => Promise<void>;
  runtimeDefaults: RuntimeDefaults | null;
  refreshRuntimeDefaults: () => Promise<void>;
  saveRuntimeDefaults: (body: RuntimeDefaults) => Promise<void>;
  openConnections: () => void;
};

export default function AppLayout() {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [simulationOpen, setSimulationOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncTask, setSyncTask] = useState<Task | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [runtimeDefaults, setRuntimeDefaults] = useState<RuntimeDefaults | null>(null);
  const apiMode: ChatApiMode = runtimeDefaults?.chat_api_mode ?? "responses";
  const isCallAnalysisRoute = location.pathname.startsWith("/analysis/call-analysis");
  const isTestWorkbenchRoute =
    location.pathname.startsWith("/analysis/simulation-packs") ||
    location.pathname.startsWith("/analysis/test-workbench") ||
    location.pathname.startsWith("/analysis/voice-ops");
  const isWideCanvasRoute =
    location.pathname === "/agent" ||
    isCallAnalysisRoute ||
    isTestWorkbenchRoute ||
    location.pathname === "/tools" ||
    location.pathname === "/logs" ||
    location.pathname === "/data-sources" ||
    location.pathname === "/pipelines" ||
    location.pathname === "/connections" ||
    location.pathname === "/" ||
    location.pathname === "/vectors" ||
    location.pathname === "/knowledge-lab" ||
    location.pathname === "/config-explorer" ||
    location.pathname === "/settings";

  useEffect(() => {
    void refreshRuntimeDefaults().catch(() => null);
  }, []);

  useEffect(() => {
    const openSimulation = () => setSimulationOpen(true);
    window.addEventListener("ghostdash:open-simulation", openSimulation);
    return () => window.removeEventListener("ghostdash:open-simulation", openSimulation);
  }, []);

  useEffect(() => {
    if (isCallAnalysisRoute || isTestWorkbenchRoute) {
      setChatOpen(false);
    }
  }, [isCallAnalysisRoute, isTestWorkbenchRoute]);

  async function refreshConnections() {
    setConnections(await ghostApi.fetchConnections());
  }

  async function refreshRuntimeDefaults() {
    setRuntimeDefaults(await ghostApi.fetchRuntimeDefaults());
  }

  async function persistRuntimeDefaults(body: RuntimeDefaults) {
    const saved = await ghostApi.saveRuntimeDefaults(body);
    setRuntimeDefaults(saved);
  }

  function openConnections() {
    setRightOpen(true);
    void refreshConnections().catch(() => null);
  }

  async function handleFullSync(corpus?: string) {
    setSyncing(true);
    setSyncOpen(true);
    setSyncTask(pendingTask);
    try {
      const task = await ghostApi.startSync(corpus);
      let current = task;
      setSyncTask(current);
      while (current.status === "pending" || current.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        current = await ghostApi.getTask(task.id);
        setSyncTask(current);
      }
      if (current.status === "completed") {
        window.setTimeout(() => {
          setSyncOpen(false);
        }, 1200);
      }
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[#f4f5f7] text-slate-900">
      <BackgroundOrbs />
      <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen((value) => !value)} />
      <main className="relative z-10 flex min-w-0 flex-1 flex-col">
        <Header
          syncing={syncing}
          onToggleSidebar={() => setSidebarOpen((value) => !value)}
          onFullSync={() => void handleFullSync()}
          onToggleRight={openConnections}
          onOpenSimulation={() => setSimulationOpen(true)}
        />
        <div className="ghost-scroll relative flex-1 overflow-y-auto p-[18px]">
          <div className={`mx-auto w-full ${isWideCanvasRoute ? "max-w-none" : "max-w-[960px]"}`}>
            <Outlet
              context={{
                uploadFile: ghostApi.uploadFile,
                startSync: handleFullSync,
                refreshConnections,
                runtimeDefaults,
                refreshRuntimeDefaults,
                saveRuntimeDefaults: persistRuntimeDefaults,
                openConnections,
              } satisfies AppOutletContext}
            />
          </div>
        </div>
      </main>
      <RightPanel
        open={rightOpen}
        onClose={() => setRightOpen(false)}
        connections={connections}
        apiMode={apiMode}
        runtimeDefaults={runtimeDefaults}
        onSaveChatApiMode={async (mode) => {
          if (!runtimeDefaults) return;
          await persistRuntimeDefaults({ ...runtimeDefaults, chat_api_mode: mode });
        }}
        onSave={async (body) => {
          await ghostApi.saveConnection(body);
          await refreshConnections();
          window.dispatchEvent(new CustomEvent(CONNECTIONS_UPDATED_EVENT));
          setRightOpen(false);
        }}
        onDelete={async (connectionId, confirmationToken) => {
          await ghostApi.deleteConnection(connectionId, confirmationToken);
          await refreshConnections();
          window.dispatchEvent(new CustomEvent(CONNECTIONS_UPDATED_EVENT));
          setRightOpen(false);
        }}
      />
      <AgentSimulationPanel open={simulationOpen} onClose={() => setSimulationOpen(false)} />
      {!simulationOpen && !isCallAnalysisRoute && (
        <button
          type="button"
          aria-label="Open simulator panel"
          title="Open simulator (Magic Mike chat + booking workflow)"
          onClick={() => setSimulationOpen(true)}
          className="fixed bottom-6 right-6 z-[9996] flex h-14 w-14 items-center justify-center rounded-full border-2 border-orange-500 bg-slate-900 text-white shadow-xl ring-4 ring-orange-500/25 transition hover:scale-105 hover:bg-slate-800"
        >
          <svg viewBox="0 0 24 24" width={22} height={22} fill="currentColor" aria-hidden>
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
          </svg>
        </button>
      )}
      {!isCallAnalysisRoute && !isTestWorkbenchRoute && (
        <GhostChatMirror
          open={chatOpen}
          onOpen={() => setChatOpen(true)}
          onClose={() => setChatOpen(false)}
        />
      )}
      <FullScreenLoader open={syncOpen} task={syncTask} onClose={() => setSyncOpen(false)} />
    </div>
  );
}
