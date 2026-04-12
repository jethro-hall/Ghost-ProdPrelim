import { Link } from "react-router-dom";
import { type AgentProfile, type ChatApiMode } from "../../api";

type Props = {
  open: boolean;
  onClose: () => void;
  chatEngine: any; // Type from useChatEngine
};

export default function ChatSidebar({ open, onClose, chatEngine }: Props) {
  const {
    agents,
    activeAgentId,
    changeAgent,
    clearChat,
    sessionApiMode,
    setSessionApiMode,
    sessionLlmModelId,
    setSessionLlmModelId,
    llmTokenTotal,
  } = chatEngine;

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-slate-100 bg-slate-50 transition-transform duration-300 ease-in-out lg:static lg:translate-x-0 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="flex h-14 items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-1.5 text-left text-base font-extrabold tracking-tight text-slate-900">
          <span aria-hidden="true">👻</span>
          <span>
            Ghost<span className="font-normal text-slate-500">DASH</span>
          </span>
        </Link>
        <button type="button" onClick={onClose} className="lg:hidden p-1 text-slate-400 hover:text-slate-900">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinelinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4">
        <button
          type="button"
          onClick={clearChat}
          className="mb-6 flex w-full items-center justify-between rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-sm border border-slate-200 hover:border-ghost-orange hover:text-ghost-orange transition-colors"
        >
          <span>New Chat</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinelinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>

        <div className="mb-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">LLM (this session)</div>
          <p className="mt-1 text-[0.65rem] leading-relaxed text-slate-500">
            Applies to the next message only. Switching agent resets to that agent&apos;s saved defaults; you can override again here.
          </p>
          <label className="mt-2 block text-[0.7rem] font-medium text-slate-600">API mode</label>
          <select
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-900"
            value={sessionApiMode}
            onChange={(event) => setSessionApiMode(event.target.value as ChatApiMode)}
          >
            <option value="responses">OpenAI Responses (stateful chain)</option>
            <option value="chat_completions">Chat completions</option>
          </select>
          <label className="mt-2 block text-[0.7rem] font-medium text-slate-600">Model id</label>
          <input
            className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 font-mono text-[0.65rem] text-slate-900"
            value={sessionLlmModelId}
            onChange={(event) => setSessionLlmModelId(event.target.value)}
            placeholder="openai/gpt-4o-mini"
          />
          <div
            className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[0.65rem] text-slate-700"
            title="Approximate LLM tokens (cl100k) for this conversation: prompt + completion, summed across turns. Not identical to provider billing."
          >
            <span className="font-medium text-slate-900">LLM tokens (est.)</span>
            <span className="ml-2 font-mono tabular-nums">{llmTokenTotal.toLocaleString()}</span>
          </div>
        </div>

        <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Active Agents
        </div>
        
        <div className="space-y-1">
          {agents.map((agent: AgentProfile) => {
            const isActive = agent.id === activeAgentId;
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => {
                  changeAgent(agent.id);
                  if (window.innerWidth < 1024) onClose();
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                  isActive 
                    ? "bg-slate-200/50 font-medium text-slate-900" 
                    : "text-slate-600 hover:bg-slate-200/30 hover:text-slate-900"
                }`}
              >
                <div className={`flex h-6 w-6 items-center justify-center rounded-md ${isActive ? 'bg-ghost-orange/10 text-ghost-orange' : 'bg-white text-slate-400 border border-slate-200'}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinelinejoin="round">
                    <path d="M12 2a5 5 0 1 0 0 10 5 5 0 1 0 0-10z"></path>
                    <path d="M18 22h-12a4 4 0 0 1 -4-4 7 7 0 0 1 14 0 4 4 0 0 1 -4 4z"></path>
                  </svg>
                </div>
                <div className="truncate flex-1">{agent.name}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-slate-200 p-4">
        <Link 
          to="/"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinelinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="3" y1="9" x2="21" y2="9"></line>
            <line x1="9" y1="21" x2="9" y2="9"></line>
          </svg>
          SYNC TO DASHBOARD
        </Link>
      </div>
    </aside>
  );
}
