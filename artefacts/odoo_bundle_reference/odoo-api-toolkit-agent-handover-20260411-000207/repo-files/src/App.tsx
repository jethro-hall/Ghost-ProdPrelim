import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router';

import { Layout } from './components/Layout';

import { Agents } from './pages/Agents';
import { Tools } from './pages/Tools';
import { Logs } from './pages/Logs';
import { LlmLogs } from './pages/LlmLogs';
import { Evergreen } from './pages/Evergreen';
import { ElevenLabs } from './pages/ElevenLabs';
import { Login } from './pages/Login';
import { LlmSettings } from './pages/LlmSettings';
import { Settings } from './pages/Settings';
import { Ghost } from './pages/Ghost';
import { AgentKnowledgeBase } from './pages/AgentKnowledgeBase';
import { KnowledgeBase } from './pages/KnowledgeBase';
import { Monitoring } from './pages/Monitoring';
import { Orchestration } from './pages/Orchestration';
import { IntegrationLab } from './pages/IntegrationLab';

import { apiFetch, clearToken, isAuthed } from './lib/auth';

function RequireAuth() {
  const location = useLocation();
  const [status, setStatus] = useState<'checking' | 'ok' | 'unauthorized'>(
    isAuthed() ? 'checking' : 'unauthorized'
  );

  useEffect(() => {
    let cancelled = false;
    if (!isAuthed()) {
      setStatus('unauthorized');
      return;
    }
    setStatus('checking');
    apiFetch('/api/auth/me')
      .then(() => {
        if (!cancelled) setStatus('ok');
      })
      .catch(() => {
        clearToken();
        if (!cancelled) setStatus('unauthorized');
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  if (status === 'checking') {
    return <div className="min-h-screen bg-[#081018]" />;
  }
  if (status !== 'ok') return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route element={<RequireAuth />}>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/monitoring" replace />} />
            <Route path="overview" element={<Navigate to="/monitoring" replace />} />
            <Route path="monitoring" element={<Monitoring />} />
            <Route path="agents" element={<Agents />} />
            <Route path="ghost" element={<Ghost />} />
            <Route path="files" element={<Navigate to="/tools" replace />} />
            <Route path="tools" element={<Tools />} />
            <Route path="integration-lab" element={<IntegrationLab />} />
            <Route path="tool-gateway" element={<Navigate to="/tools" replace />} />
            <Route path="rag-ops" element={<Navigate to="/agent-knowledge" replace />} />
            <Route path="llm-settings" element={<LlmSettings />} />
            <Route path="models" element={<Navigate to="/llm-settings?tab=catalog" replace />} />
            <Route path="elevenlabs" element={<ElevenLabs />} />
            <Route path="evergreen" element={<Evergreen />} />
            <Route path="traces" element={<Navigate to="/logs" replace />} />
            <Route path="logs" element={<Logs />} />
            <Route path="llm-logs" element={<LlmLogs />} />
            <Route path="knowledge" element={<AgentKnowledgeBase />} />
            <Route path="agent-knowledge" element={<AgentKnowledgeBase />} />
            <Route path="knowledge-test" element={<KnowledgeBase />} />
            <Route path="docling-test" element={<KnowledgeBase />} />
            <Route path="orchestration" element={<Orchestration />} />
            <Route path="experiments" element={<Navigate to="/agent-knowledge?tab=experiments" replace />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/monitoring" replace />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
