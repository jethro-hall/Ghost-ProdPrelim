import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchChatBootstrap, type ChatApiMode } from "../../api";
import { useChatEngine } from "../../hooks/useChatEngine";
import ChatSidebar from "./ChatSidebar";
import ChatArea from "./ChatArea";

export default function ChatPage() {
  const [apiMode, setApiMode] = useState<ChatApiMode>("chat_completions");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const bootstrap = await fetchChatBootstrap("ghostdash");
        setApiMode(bootstrap.runtime_defaults.chat_api_mode);
      } catch (err) {
        console.error("Could not fetch chat bootstrap", err);
      }
    })();
  }, []);

  const chatEngine = useChatEngine({ defaultApiMode: apiMode });

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white font-sans text-slate-900">
      <ChatSidebar 
        open={sidebarOpen} 
        onClose={() => setSidebarOpen(false)} 
        chatEngine={chatEngine} 
      />
      
      <main className="flex min-w-0 flex-1 flex-col relative">
        <header className="flex h-14 items-center justify-between border-b border-slate-100 bg-white/80 px-4 backdrop-blur-md lg:hidden">
          <button 
            type="button" 
            onClick={() => setSidebarOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinelinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          <div className="text-sm font-semibold">GhostChat</div>
          <Link to="/" className="text-xs font-medium text-ghost-orange">Dashboard</Link>
        </header>

        <ChatArea chatEngine={chatEngine} />
      </main>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
}
