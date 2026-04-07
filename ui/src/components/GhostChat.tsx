import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { AgentProfile, ChatApiMode, ConversationSummary } from "../api";
import { fetchAgentConversations, fetchAgents, fetchConversationMessages, streamChat } from "../api";
import { CloseIcon, MessageSquareIcon, PlusIcon, SendIcon } from "./ReferenceIcons";

type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  queryMode?: string;
  citations?: unknown[];
};

type Props = {
  open: boolean;
  apiMode: ChatApiMode;
  onOpen: () => void;
  onClose: () => void;
};

export default function GhostChat({ open, apiMode, onOpen, onClose }: Props) {
  const [message, setMessage] = useState("");
  const [log, setLog] = useState<ChatEntry[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [useApprovedWeb, setUseApprovedWeb] = useState(false);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const nextAgents = await fetchAgents();
      setAgents(nextAgents);
      const targetAgent = nextAgents.find((agent) => agent.id === activeAgentId) ?? nextAgents.find((agent) => agent.is_default) ?? nextAgents[0] ?? null;
      if (!targetAgent) return;
      setActiveAgentId(targetAgent.id);
      const nextConversations = await fetchAgentConversations(targetAgent.id);
      setConversations(nextConversations);
      const recentConversation = nextConversations[0] ?? null;
      if (!recentConversation) {
        setActiveConversationId(null);
        setLog([]);
        return;
      }
      setActiveConversationId(recentConversation.id);
      const messages = await fetchConversationMessages(recentConversation.id);
      setLog(
        messages.map((entry) => ({
          id: entry.id,
          role: entry.role,
          text: entry.content,
          queryMode: entry.query_mode ?? undefined,
          citations: entry.citations,
        })),
      );
    })().catch(() => null);
  }, [open]);

  async function loadConversation(agentId: string, conversationId: string | null) {
    setActiveAgentId(agentId);
    setActiveConversationId(conversationId);
    if (!conversationId) {
      setLog([]);
      return;
    }
    const messages = await fetchConversationMessages(conversationId);
    setLog(
      messages.map((entry) => ({
        id: entry.id,
        role: entry.role,
        text: entry.content,
        queryMode: entry.query_mode ?? undefined,
        citations: entry.citations,
      })),
    );
  }

  async function refreshConversations(agentId: string, preferredConversationId?: string | null) {
    const nextConversations = await fetchAgentConversations(agentId);
    setConversations(nextConversations);
    const nextConversation = nextConversations.find((entry) => entry.id === preferredConversationId) ?? nextConversations[0] ?? null;
    await loadConversation(agentId, nextConversation?.id ?? null);
  }

  async function send() {
    if (!message.trim() || busy || !activeAgentId) return;
    const userText = message.trim();
    const assistantId = crypto.randomUUID();
    setMessage("");
    setBusy(true);
    setLog((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", text: userText },
      { id: assistantId, role: "assistant", text: "" },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat({
        message: userText,
        apiMode,
        agentId: activeAgentId,
        conversationId: activeConversationId ?? undefined,
        useApprovedWeb,
        signal: controller.signal,
        onStart: ({ query_mode, conversation_id }) => {
          if (conversation_id) {
            setActiveConversationId(conversation_id);
          }
          setLog((items) =>
            items.map((entry) => (entry.id === assistantId ? { ...entry, queryMode: query_mode } : entry)),
          );
        },
        onDelta: (delta) => {
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId ? { ...entry, text: `${entry.text}${delta}` } : entry,
            ),
          );
        },
        onDone: async ({ citations, conversation_id }) => {
          setLog((items) =>
            items.map((entry) => (entry.id === assistantId ? { ...entry, citations } : entry)),
          );
          await refreshConversations(activeAgentId, conversation_id ?? activeConversationId);
        },
      });
    } catch (error) {
      setLog((items) =>
        items.map((entry) =>
          entry.id === assistantId ? { ...entry, text: `Error: ${String(error)}` } : entry,
        ),
      );
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  function handleClose() {
    abortRef.current?.abort();
    onClose();
  }

  const activeAgent = agents.find((agent) => agent.id === activeAgentId) ?? null;
  const webTool = activeAgent?.runtime_profile.tool_policy_config.tools.find((tool) => tool.id === "web") ?? null;
  const approvedWebConfigured = Boolean(webTool?.enabled && (webTool.allowed_urls?.length ?? 0) > 0);

  useEffect(() => {
    if (!approvedWebConfigured) {
      setUseApprovedWeb(false);
    }
  }, [approvedWebConfigured]);

  return (
    <div className="fixed bottom-0 left-1/2 z-[9999] flex w-1/2 max-w-[600px] -translate-x-1/2 flex-col items-center">
      <AnimatePresence>
        {!open && (
          <motion.button
            type="button"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            onClick={onOpen}
            className="glass-chat mb-0 flex items-center gap-2 rounded-t-md border-b-0 px-4 py-1.5 text-[0.75rem] font-semibold text-slate-900"
          >
            <MessageSquareIcon size={14} />
            GhostChat
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 380, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="glass-chat flex w-full flex-col overflow-hidden rounded-t-lg border-b-0"
          >
            <div className="flex items-center justify-between border-b border-black/5 bg-white/50 p-3">
              <div className="flex items-center gap-2 text-[0.85rem] font-semibold text-slate-900">
                <MessageSquareIcon size={16} className="text-ghost-orange" />
                GhostChat
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowTools((current) => !current)}
                  className={`ghost-icon-btn ${showTools ? "text-ghost-orange" : "text-slate-500"}`}
                  title="Chat tools"
                >
                  <PlusIcon size={16} />
                </button>
                <select
                  className="ghost-select w-[170px] py-2 text-[0.72rem]"
                  value={activeAgentId ?? ""}
                  onChange={(event) => {
                    const nextAgentId = event.target.value;
                    void (async () => {
                      const nextConversations = await fetchAgentConversations(nextAgentId);
                      setConversations(nextConversations);
                      const nextConversation = nextConversations[0] ?? null;
                      await loadConversation(nextAgentId, nextConversation?.id ?? null);
                    })().catch(() => null);
                  }}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <select
                  className="ghost-select w-[170px] py-2 text-[0.72rem]"
                  value={activeConversationId ?? "__new__"}
                  onChange={(event) => {
                    const nextConversationId = event.target.value === "__new__" ? null : event.target.value;
                    void loadConversation(activeAgentId ?? "", nextConversationId).catch(() => null);
                  }}
                >
                  <option value="__new__">New conversation</option>
                  {conversations.map((conversation) => (
                    <option key={conversation.id} value={conversation.id}>
                      {conversation.title}
                    </option>
                  ))}
                </select>
                <div className="rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-[0.7rem] font-semibold text-slate-600">
                  {apiMode === "chat_completions" ? "Chat Completions" : "Responses"} API
                </div>
                <button type="button" onClick={handleClose} className="ghost-icon-btn text-slate-500">
                  <CloseIcon size={14} />
                </button>
              </div>
            </div>
            {showTools && (
              <div className="border-b border-black/5 bg-white/60 p-3 text-[0.72rem] text-slate-600">
                <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                  <div className="font-semibold text-slate-900">Approved web sources</div>
                  <div className="mt-1 text-[0.7rem] text-slate-500">
                    Tool policy is owned by the agent runtime profile. Configure enablement and allowed websites in Agent Config; GhostChat can only request a one-off fetch from that stored allowlist.
                  </div>
                  <div className="mt-3 text-[0.7rem] text-slate-500">
                    Tool status: <span className="font-semibold text-slate-900">{webTool?.enabled ? "Enabled" : "Disabled"}</span>
                  </div>
                  <div className="mt-1 text-[0.7rem] text-slate-500">
                    Allowed sources:{" "}
                    <span className="font-semibold text-slate-900">
                      {webTool?.allowed_urls?.length ? webTool.allowed_urls.join(", ") : "None configured"}
                    </span>
                  </div>
                  <label className="mt-3 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={useApprovedWeb}
                      disabled={!approvedWebConfigured}
                      onChange={() => setUseApprovedWeb((current) => !current)}
                    />
                    Force approved web use for this message
                  </label>
                  {!approvedWebConfigured && (
                    <div className="mt-2 text-[0.7rem] text-slate-500">
                      Enable the approved web tool and store at least one website in Agent Config before using it here.
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="ghost-scroll flex flex-1 flex-col gap-3 overflow-y-auto p-4 text-[0.8rem]">
              {log.length === 0 && (
                <div className="self-start rounded-lg rounded-tl-none border border-slate-200 bg-slate-50 p-2.5 text-slate-900">
                  {activeAgent?.first_message ?? "Hello! I&apos;m GhostChat. How can I help you with your RAG infrastructure today?"}
                </div>
              )}
              {log.map((entry) => (
                <div
                  key={entry.id}
                  className={
                    entry.role === "user"
                      ? "self-end max-w-[80%] rounded-lg rounded-tr-none bg-slate-900 p-2.5 text-white shadow-sm"
                      : "self-start max-w-[80%] rounded-lg rounded-tl-none border border-slate-200 bg-slate-50 p-2.5 text-slate-900"
                  }
                >
                  {entry.queryMode && entry.role === "assistant" && (
                    <div className="mb-1 text-[0.62rem] font-bold uppercase tracking-[0.16em] text-ghost-orange">
                      {entry.queryMode}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap">{entry.text || (busy ? "..." : "")}</div>
                  {entry.citations && entry.citations.length > 0 && (
                    <div className="mt-2 text-[0.68rem] text-slate-500">{entry.citations.length} citation(s)</div>
                  )}
                </div>
              ))}
            </div>

            <div className="border-t border-black/5 bg-white/50 p-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Ask anything..."
                  className="ghost-input flex-1 py-2 text-[0.8rem]"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <button type="button" className="ghost-btn-primary px-3" disabled={busy} onClick={() => void send()}>
                  <SendIcon size={16} />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
