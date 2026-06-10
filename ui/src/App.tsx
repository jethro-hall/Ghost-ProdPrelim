import { Route, Routes } from "react-router-dom";
import AppLayout from "./components/AppLayout";
import AgentConfigPage from "./pages/AgentConfigPage";
import ConnectionsPage from "./pages/ConnectionsPage";
import Dashboard from "./pages/Dashboard";
import DataSourcesPage from "./pages/DataSourcesPage";
import ConfigExplorerPage from "./pages/ConfigExplorerPage";
import KnowledgeLabPage from "./pages/KnowledgeLabPage";
import ElevenLabsAnalysisPage from "./pages/ElevenLabsAnalysisPage";
import ElevenLabsOperatorPage from "./pages/ElevenLabsOperatorPage";
import ElevenLabsTestWorkbenchPage from "./pages/ElevenLabsTestWorkbenchPage";
import Logs from "./pages/Logs";
import PipelinesPage from "./pages/PipelinesPage";
import SettingsPage from "./pages/SettingsPage";
import ToolsPage from "./pages/ToolsPage";
import VectorsPage from "./pages/VectorsPage";

import ChatPage from "./pages/chat/ChatPage";

export default function App() {
  return (
    <Routes>
      {/* Legacy dev-only full-page chat; production uses https://ghoststack.rideai.com.au/ghost_chatui/ (Caddy redirects /chat* → /ghost_chatui/). */}
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
        <Route path="config-explorer" element={<ConfigExplorerPage />} />
        <Route path="agent" element={<AgentConfigPage />} />
        <Route path="logs" element={<Logs />} />
        <Route path="analysis/call-analysis" element={<ElevenLabsAnalysisPage />} />
        <Route path="analysis/call-analysis/:conversationId" element={<ElevenLabsAnalysisPage />} />
        <Route path="analysis/simulation-packs" element={<ElevenLabsTestWorkbenchPage />} />
        <Route path="analysis/test-workbench" element={<ElevenLabsTestWorkbenchPage />} />
        <Route path="analysis/voice-ops" element={<ElevenLabsOperatorPage />} />
      </Route>
    </Routes>
  );
}
