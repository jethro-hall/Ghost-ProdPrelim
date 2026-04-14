import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { AgentProfile, ChatApiMode, ChatToolEvent, ChatUpload, Collection, ConversationSummary, RequestedLane } from "../api";
import {
  decideChatUpload,
  fetchAgentConversations,
  fetchChatBootstrap,
  fetchCollections,
  fetchConversationMessages,
  fetchConversationUploads,
  stageConversationUpload,
  streamChat,
} from "../api";
import { CloseIcon, MessageSquareIcon, PlusIcon, SendIcon } from "./ReferenceIcons";

type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  queryMode?: string;
  citations?: unknown[];
  toolEvents?: ChatToolEvent[];
};

function hydrateToolEvents(citations: unknown[] | undefined): ChatToolEvent[] {
  return (citations ?? [])
    .filter((cite: any) => cite?.source_type === "tool")
    .map((cite: any) => ({
      tool_id: cite?.tool_id || "odoo_primary",
      status: cite?.tool_status || "executed",
      operation: cite?.operation || null,
      summary: cite?.title || cite?.filename || null,
      blocked_reason: null,
      payload: {},
      latency_ms: null,
    }));
}

type Props = {
  open: boolean;
  apiMode: ChatApiMode;
  startSync: (corpus?: string) => Promise<void>;
  onOpen: () => void;
  onClose: () => void;
};

export default function GhostChat({ open, apiMode, startSync, onOpen, onClose }: Props) {
  const [message, setMessage] = useState("");
  const [log, setLog] = useState<ChatEntry[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [uploads, setUploads] = useState<ChatUpload[]>([]);
  const [uploadLane, setUploadLane] = useState<RequestedLane>("default");
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [selectedCollectionByUpload, setSelectedCollectionByUpload] = useState<Record<string, string>>({});
  const [showTools, setShowTools] = useState(false);
  const [useApprovedWeb, setUseApprovedWeb] = useState(false);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeAgent = agents.find((entry) => entry.id === activeAgentId) ?? null;
  const [sessionApiMode, setSessionApiMode] = useState<ChatApiMode>(apiMode);
  const [sessionLlmModelId, setSessionLlmModelId] = useState("");
  const [llmTokenTotal, setLlmTokenTotal] = useState(0);

  useEffect(() => {
    const agent = agents.find((entry) => entry.id === activeAgentId);
    if (!agent) return;
    setSessionApiMode(agent.runtime_profile.llm_config.api_mode);
    setSessionLlmModelId(agent.runtime_profile.llm_config.model_id);
  }, [activeAgentId, agents]);

  useEffect(() => {
    setLlmTokenTotal(0);
  }, [activeConversationId]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function updateUploadCollectionDefaults(nextUploads: ChatUpload[], nextCollections: Collection[]) {
    setSelectedCollectionByUpload((current) => {
      const fallbackId = nextCollections[0]?.id ?? "";
      const next = { ...current };
      for (const upload of nextUploads) {
        if (next[upload.id]) continue;
        next[upload.id] = upload.collection_id ?? fallbackId;
      }
      return next;
    });
  }

  async function refreshUploads(conversationId: string | null, nextCollections: Collection[] = collections) {
    if (!conversationId) {
      setUploads([]);
      return;
    }
    const nextUploads = await fetchConversationUploads(conversationId);
    setUploads(nextUploads);
    updateUploadCollectionDefaults(nextUploads, nextCollections);
  }

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const bootstrap = await fetchChatBootstrap("ghostdash");
      const nextAgents = bootstrap.agents;
      const nextCollections = await fetchCollections();
      setAgents(nextAgents);
      setCollections(nextCollections);
      const targetAgent =
        nextAgents.find((agent) => agent.id === activeAgentId) ??
        nextAgents.find((agent) => agent.id === bootstrap.default_agent_id) ??
        nextAgents.find((agent) => agent.is_default) ??
        nextAgents[0] ??
        null;
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
          toolEvents: hydrateToolEvents(entry.citations),
        })),
      );
      await refreshUploads(recentConversation.id, nextCollections);
    })().catch(() => null);
  }, [open]);

  async function loadConversation(agentId: string, conversationId: string | null) {
    setActiveAgentId(agentId);
    setActiveConversationId(conversationId);
    if (!conversationId) {
      setLog([]);
      setUploads([]);
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
        toolEvents: hydrateToolEvents(entry.citations),
      })),
    );
    await refreshUploads(conversationId);
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
      { id: assistantId, role: "assistant", text: "", toolEvents: [] },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat({
        message: userText,
        apiMode: sessionApiMode,
        llmModelId: sessionLlmModelId.trim() || null,
        agentId: activeAgentId,
        conversationId: activeConversationId ?? undefined,
        useApprovedWeb,
        signal: controller.signal,
        onStart: ({ query_mode, conversation_id, tool_events }) => {
          if (conversation_id) {
            setActiveConversationId(conversation_id);
            void refreshUploads(conversation_id).catch(() => null);
          }
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId
                ? { ...entry, queryMode: query_mode, toolEvents: tool_events ?? entry.toolEvents ?? [] }
                : entry
            ),
          );
        },
        onToolEvent: ({ tool_event }) => {
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId
                ? { ...entry, toolEvents: [...(entry.toolEvents ?? []), tool_event] }
                : entry
            ),
          );
        },
        onDelta: (delta) => {
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId ? { ...entry, text: `${entry.text}${delta}` } : entry,
            ),
          );
        },
        onDone: async ({ citations, conversation_id, usage, tool_events }) => {
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId
                ? { ...entry, citations, toolEvents: tool_events ?? entry.toolEvents ?? [] }
                : entry
            ),
          );
          if (usage && typeof usage.total_tokens === "number") {
            setLlmTokenTotal((n) => n + usage.total_tokens);
          }
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

  async function handleStageUpload(file: File) {
    if (!activeConversationId || !activeAgentId) return;
    setUploadBusy(true);
    setUploadStatus(`Uploading ${file.name} into the active conversation...`);
    try {
      const upload = await stageConversationUpload({
        conversationId: activeConversationId,
        agentId: activeAgentId,
        file,
        policyLane: uploadLane,
      });
      await refreshUploads(activeConversationId);
      setUploadStatus(
        upload.error_message
          ? `${upload.filename} uploaded. Chat preview extraction had a warning, but you can still use it or save it to knowledge.`
          : `${upload.filename} uploaded. Choose whether it stays conversation-only or becomes saved agent knowledge.`,
      );
      setShowTools(true);
    } catch (error) {
      setUploadStatus(`Upload failed: ${String(error)}`);
    } finally {
      setUploadBusy(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleConversationOnly(uploadId: string) {
    setUploadBusy(true);
    try {
      await decideChatUpload({ uploadId, persistenceMode: "conversation_only" });
      await refreshUploads(activeConversationId);
      setUploadStatus("The file is now available only inside this conversation and will not be indexed into shared knowledge.");
    } catch (error) {
      setUploadStatus(`Could not update upload decision: ${String(error)}`);
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleSaveDecision(uploadId: string) {
    setUploadBusy(true);
    try {
      await decideChatUpload({ uploadId, persistenceMode: "save_to_knowledge" });
      await refreshUploads(activeConversationId);
      setUploadStatus("Knowledge persistence requested. Pick the collection that should own this file before indexing starts.");
    } catch (error) {
      setUploadStatus(`Could not stage knowledge save: ${String(error)}`);
    } finally {
      setUploadBusy(false);
    }
  }

  async function handleConfirmCollection(upload: ChatUpload) {
    const selectedCollectionId = selectedCollectionByUpload[upload.id];
    const selectedCollection = collections.find((entry) => entry.id === selectedCollectionId) ?? null;
    if (!selectedCollection) {
      setUploadStatus("Choose a valid collection before saving to durable knowledge.");
      return;
    }
    setUploadBusy(true);
    setUploadStatus(`Saving ${upload.filename} into ${selectedCollection.slug} and starting ingestion...`);
    try {
      const updated = await decideChatUpload({
        uploadId: upload.id,
        persistenceMode: "save_to_knowledge",
        collectionId: selectedCollection.id,
      });
      await refreshUploads(activeConversationId);
      await startSync(updated.collection_slug ?? selectedCollection.slug);
      await refreshUploads(activeConversationId);
      setUploadStatus(`${upload.filename} is now attached to ${updated.collection_slug ?? selectedCollection.slug} and has been queued for indexing.`);
    } catch (error) {
      setUploadStatus(`Could not save file into knowledge: ${String(error)}`);
    } finally {
      setUploadBusy(false);
    }
  }

  const webTool = activeAgent?.runtime_profile.tool_policy_config.tools.find((tool) => tool.id === "web") ?? null;
  const approvedWebConfigured = Boolean(webTool?.enabled && (webTool.allowed_urls?.length ?? 0) > 0);

  useEffect(() => {
    if (!approvedWebConfigured) {
      setUseApprovedWeb(false);
    }
  }, [approvedWebConfigured]);

  return (
    <div className="fixed bottom-4 left-1/2 z-[9999] flex w-[min(1120px,calc(100vw-1.5rem))] max-w-none -translate-x-1/2 flex-col items-center">
      <AnimatePresence>
        {!open && (
          <motion.button
            type="button"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            onClick={onOpen}
            className="glass-chat mb-0 flex items-center gap-2 rounded-t-xl border-b-0 px-4 py-2 text-[0.78rem] font-semibold text-slate-900"
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
            animate={{ height: 430, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="ghost-chat-panel glass-chat flex w-full flex-col overflow-hidden rounded-2xl border-b-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/5 bg-white/50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div className="flex items-center gap-2 text-[0.85rem] font-semibold text-slate-900">
                  <MessageSquareIcon size={16} className="text-ghost-orange" />
                  GhostChat
                </div>
                <span
                  className="text-[0.68rem] text-slate-600"
                  title="Approximate LLM tokens (cl100k) for this conversation, summed across turns."
                >
                  Tokens (est.):{" "}
                  <span className="font-mono tabular-nums font-medium text-slate-900">{llmTokenTotal.toLocaleString()}</span>
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowTools((current) => !current)}
                  className={`ghost-icon-btn ${showTools ? "text-ghost-orange" : "text-slate-500"}`}
                  title="Chat tools"
                >
                  <PlusIcon size={16} />
                </button>
                <select
                  className="ghost-select w-[160px]"
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
                  className="ghost-select w-[160px]"
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
                <select
                  className="ghost-select max-w-[156px]"
                  value={sessionApiMode}
                  onChange={(event) => setSessionApiMode(event.target.value as ChatApiMode)}
                  title="OpenAI API path for the next message"
                >
                  <option value="responses">OpenAI Responses (stateful chain)</option>
                  <option value="chat_completions">Chat completions</option>
                </select>
                <input
                  className="ghost-input max-w-[160px]"
                  value={sessionLlmModelId}
                  onChange={(event) => setSessionLlmModelId(event.target.value)}
                  placeholder="Model id"
                  title="Per-message model (e.g. openai/gpt-4o-mini). Cleared uses agent default."
                />
                <button type="button" onClick={handleClose} className="ghost-icon-btn text-slate-500">
                  <CloseIcon size={14} />
                </button>
              </div>
            </div>
            {showTools && (
              <div className="ghost-scroll max-h-[180px] overflow-y-auto border-b border-black/5 bg-white/60 px-3 py-2 text-[0.72rem] text-slate-600">
                <div className="grid gap-3 md:grid-cols-2">
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
                  <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-semibold text-slate-900">Conversation uploads</div>
                        <div className="mt-1 text-[0.7rem] text-slate-500">
                          Upload after the assistant asks for a document, then choose whether it stays in this chat only or is promoted into durable agent knowledge with a collection assignment.
                        </div>
                      </div>
                      <button
                        type="button"
                        className="ghost-btn-primary"
                        disabled={!activeConversationId || !activeAgentId || uploadBusy}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Attach file
                      </button>
                    </div>
                    <div className="mt-3 flex items-center gap-2 text-[0.7rem]">
                      <span className="text-slate-500">Parse lane</span>
                      <select
                        className="ghost-select py-1 text-[0.7rem]"
                        value={uploadLane}
                        onChange={(event) => setUploadLane(event.target.value as RequestedLane)}
                      >
                        <option value="default">Default</option>
                        <option value="local">Local</option>
                        <option value="cloud">Cloud</option>
                      </select>
                    </div>
                    <div className="mt-3 text-[0.7rem] text-slate-500">
                      {activeConversationId
                        ? "Uploads are scoped to the active conversation and become durable knowledge only after explicit collection confirmation."
                        : "Start or select a conversation before attaching a file."}
                    </div>
                    {uploadStatus && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.7rem] text-slate-700">{uploadStatus}</div>}
                    <div className="mt-3 space-y-2">
                      {uploads.map((upload) => (
                        <div key={upload.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="font-semibold text-slate-900">{upload.filename}</div>
                              <div className="mt-1 text-[0.68rem] text-slate-500">
                                {upload.status}
                                {upload.collection_slug ? ` | collection: ${upload.collection_slug}` : ""}
                                {upload.extracted_parse_lane ? ` | preview lane: ${upload.extracted_parse_lane}` : ""}
                              </div>
                            </div>
                          </div>
                          {upload.error_message && (
                            <div className="mt-2 text-[0.68rem] text-amber-700">{upload.error_message}</div>
                          )}
                          {upload.status === "uploaded_pending_decision" && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                type="button"
                                className="ghost-btn"
                                disabled={uploadBusy}
                                onClick={() => void handleConversationOnly(upload.id)}
                              >
                                Use only in this conversation
                              </button>
                              <button
                                type="button"
                                className="ghost-btn-primary"
                                disabled={uploadBusy}
                                onClick={() => void handleSaveDecision(upload.id)}
                              >
                                Save to agent knowledge
                              </button>
                            </div>
                          )}
                          {upload.status === "awaiting_collection" && (
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <select
                                className="ghost-select py-2 text-[0.72rem]"
                                value={selectedCollectionByUpload[upload.id] ?? ""}
                                onChange={(event) =>
                                  setSelectedCollectionByUpload((current) => ({
                                    ...current,
                                    [upload.id]: event.target.value,
                                  }))
                                }
                              >
                                <option value="">Choose collection</option>
                                {collections.map((collection) => (
                                  <option key={collection.id} value={collection.id}>
                                    {collection.name} ({collection.slug})
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="ghost-btn-primary"
                                disabled={uploadBusy || !selectedCollectionByUpload[upload.id]}
                                onClick={() => void handleConfirmCollection(upload)}
                              >
                                Confirm collection and index
                              </button>
                            </div>
                          )}
                          {upload.status === "conversation_only" && (
                            <div className="mt-3 text-[0.68rem] text-slate-600">
                              This file is available to the current conversation only and is not part of persistent agent knowledge.
                            </div>
                          )}
                          {(upload.status === "approved_for_indexing" || upload.status === "indexing" || upload.status === "indexed") && (
                            <div className="mt-3 text-[0.68rem] text-slate-600">
                              This file has been promoted into durable knowledge and routed through the collection-backed ingestion pipeline.
                            </div>
                          )}
                        </div>
                      ))}
                      {uploads.length === 0 && (
                        <div className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-[0.7rem] text-slate-500">
                          No conversation uploads yet. Ask the assistant a question first, then attach the relevant file when needed.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="ghost-scroll flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-[0.8rem]">
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
                  {entry.role === "assistant" && ((entry.toolEvents?.length ?? 0) > 0 || (entry.citations ?? []).some((cite: any) => cite?.source_type === "tool")) && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {(entry.toolEvents ?? []).map((toolEvent, idx) => (
                        <span
                          key={`${toolEvent.tool_id}-${toolEvent.operation ?? "none"}-${idx}`}
                          className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[0.62rem] font-medium text-slate-600"
                        >
                          {toolEvent.status === "executed"
                            ? `Verified via ${toolEvent.operation ?? toolEvent.tool_id}`
                            : toolEvent.status === "preview"
                              ? `Planned ${toolEvent.operation ?? toolEvent.tool_id}`
                              : `Odoo ${toolEvent.status}`}
                        </span>
                      ))}
                      {(entry.citations ?? [])
                        .filter((cite: any) => cite?.source_type === "tool")
                        .map((cite: any, idx) => (
                          <span
                            key={`tool-citation-${idx}`}
                            className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[0.62rem] font-medium text-emerald-700"
                          >
                            {cite?.title || cite?.filename || "Odoo evidence"}
                          </span>
                        ))}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap">{entry.text || (busy ? "..." : "")}</div>
                  {entry.citations && entry.citations.length > 0 && (
                    <div className="mt-2 text-[0.68rem] text-slate-500">{entry.citations.length} citation(s)</div>
                  )}
                </div>
              ))}
            </div>

            <div className="border-t border-black/5 bg-white/50 px-3 py-2.5">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void handleStageUpload(file);
                  }
                }}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="ghost-btn px-3"
                  disabled={!activeConversationId || !activeAgentId || uploadBusy}
                  onClick={() => fileInputRef.current?.click()}
                  title={activeConversationId ? "Attach file to this conversation" : "Start a conversation before uploading"}
                >
                  <PlusIcon size={16} />
                </button>
                <input
                  type="text"
                  placeholder="Ask anything..."
                  className="ghost-input flex-1"
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
