import { Outlet } from "react-router-dom";
import { useState } from "react";
import Sidebar from "./Sidebar";
import Header from "./Header";
import RightPanel from "./RightPanel";
import GhostChat from "./GhostChat";
import FullScreenLoader from "./FullScreenLoader";
import type { Connection, Task, TaskStep } from "../api";
import * as ghostApi from "../api";

const idleSteps: TaskStep[] = [
  { id: "queued", label: "Queued", done: false, active: false },
  { id: "scan_documents", label: "Scan documents", done: false, active: false },
  { id: "parse_embed", label: "Parse & embed", done: false, active: false },
  { id: "finalize", label: "Finalize", done: false, active: false },
];

export default function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncSteps, setSyncSteps] = useState<TaskStep[]>(idleSteps);
  const [syncing, setSyncing] = useState(false);

  async function refreshConnections() {
    const c = await ghostApi.fetchConnections();
    setConnections(c);
  }

  return (
    <div className="relative flex min-h-screen">
      <div className="bg-orb" />
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      <div className="relative z-10 flex flex-1 flex-col gap-4 p-4">
        <Header
          syncing={syncing}
          onFullSync={async () => {
            setSyncing(true);
            setSyncOpen(true);
            setSyncSteps(idleSteps);
            try {
              const task: Task = await ghostApi.startSync();
              let cur = task;
              setSyncSteps(cur.steps);
              while (cur.status === "pending" || cur.status === "running") {
                await new Promise((r) => setTimeout(r, 1500));
                cur = await ghostApi.getTask(task.id);
                setSyncSteps(cur.steps);
              }
            } finally {
              setSyncing(false);
              setTimeout(() => setSyncOpen(false), 800);
            }
          }}
          onToggleRight={async () => {
            await refreshConnections();
            setRightOpen(true);
          }}
          onToggleChat={() => setChatOpen((v) => !v)}
        />
        <main className="glass-panel relative z-10 flex-1 overflow-auto p-4">
          <Outlet
            context={{
              uploadFile: ghostApi.uploadFile,
              refreshConnections,
            }}
          />
        </main>
      </div>
      <RightPanel
        open={rightOpen}
        onClose={() => setRightOpen(false)}
        connections={connections}
        onSave={async (body) => {
          await ghostApi.saveConnection(body);
          await refreshConnections();
          setRightOpen(false);
        }}
      />
      <GhostChat open={chatOpen} onClose={() => setChatOpen(false)} />
      <FullScreenLoader open={syncOpen} steps={syncSteps} />
    </div>
  );
}
