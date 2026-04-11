import { Route, Routes } from "react-router-dom";
import AppLayout from "./components/AppLayout";
import AgentConfigPage from "./pages/AgentConfigPage";
import ConnectionsPage from "./pages/ConnectionsPage";
import Dashboard from "./pages/Dashboard";
import DataSourcesPage from "./pages/DataSourcesPage";
import KnowledgeLabPage from "./pages/KnowledgeLabPage";
import Logs from "./pages/Logs";
import PipelinesPage from "./pages/PipelinesPage";
import SettingsPage from "./pages/SettingsPage";
import ToolsPage from "./pages/ToolsPage";
import VectorsPage from "./pages/VectorsPage";

import ChatPage from "./pages/chat/ChatPage";

export default function App() {
  return (
    <Routes>
      <Route path="/chat" element={<ChatPage />} />
      <Route path="/" element={<AppLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="connections" element={<ConnectionsPage />} />
        <Route path="data-sources" element={<DataSourcesPage />} />
        <Route path="pipelines" element={<PipelinesPage />} />
        <Route path="vectors" element={<VectorsPage />} />
        <Route path="knowledge-lab" element={<KnowledgeLabPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="tools" element={<ToolsPage />} />
        <Route path="agent" element={<AgentConfigPage />} />
        <Route path="logs" element={<Logs />} />
      </Route>
    </Routes>
  );
}
