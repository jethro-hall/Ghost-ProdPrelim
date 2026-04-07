import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import type { ChatApiMode, Connection, RuntimeDefaults, Task } from "../api";
import * as ghostApi from "../api";
import BackgroundOrbs from "./BackgroundOrbs";
import FullScreenLoader from "./FullScreenLoader";
import GhostChat from "./GhostChat";
import Header from "./Header";
import RightPanel from "./RightPanel";
import Sidebar from "./Sidebar";

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
  uploadFile: (f: File, corpus?: string, lane?: string) => Promise<{ id: string }>;
  refreshConnections: () => Promise<void>;
  runtimeDefaults: RuntimeDefaults | null;
  refreshRuntimeDefaults: () => Promise<void>;
  saveRuntimeDefaults: (body: RuntimeDefaults) => Promise<void>;
  openConnections: () => void;
};

export default function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncTask, setSyncTask] = useState<Task | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [runtimeDefaults, setRuntimeDefaults] = useState<RuntimeDefaults | null>(null);
  const apiMode: ChatApiMode = runtimeDefaults?.chat_api_mode ?? "responses";

  useEffect(() => {
    void refreshRuntimeDefaults().catch(() => null);
  }, []);

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

  async function handleFullSync() {
    setSyncing(true);
    setSyncOpen(true);
    setSyncTask(pendingTask);
    try {
      const task = await ghostApi.startSync();
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
        />
        <div className="ghost-scroll relative flex-1 overflow-y-auto p-[18px]">
          <div className="mx-auto max-w-[960px]">
            <Outlet
              context={{
                uploadFile: ghostApi.uploadFile,
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
        onSave={async (body) => {
          await ghostApi.saveConnection(body);
          await refreshConnections();
          setRightOpen(false);
        }}
      />
      <GhostChat
        open={chatOpen}
        apiMode={apiMode}
        onOpen={() => setChatOpen(true)}
        onClose={() => setChatOpen(false)}
      />
      <FullScreenLoader open={syncOpen} task={syncTask} onClose={() => setSyncOpen(false)} />
    </div>
  );
}
