import { useEffect, useRef, useState, useCallback } from "react";
import {
  type AgentProfile,
  type ChatApiMode,
  type ChatUpload,
  type Collection,
  type ConversationSummary,
  type RequestedLane,
  decideChatUpload,
  fetchAgentConversations,
  fetchChatBootstrap,
  fetchCollections,
  fetchConversationMessages,
  fetchConversationUploads,
  stageConversationUpload,
  streamChat,
} from "../api";

export type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  queryMode?: string;
  citations?: unknown[];
};

type UseChatEngineOptions = {
  /** Fallback before agents load; session controls reset from the active agent when it changes. */
  defaultApiMode?: ChatApiMode;
  onSyncRequest?: (corpusSlug?: string) => Promise<void>;
};

export function useChatEngine({ defaultApiMode = "responses", onSyncRequest }: UseChatEngineOptions) {
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
  
  const [useApprovedWeb, setUseApprovedWeb] = useState(false);
  const [busy, setBusy] = useState(false);
  
  const abortRef = useRef<AbortController | null>(null);
  const sendLockRef = useRef(false);
  const activeAgent = agents.find((entry) => entry.id === activeAgentId) ?? null;
  const [sessionApiMode, setSessionApiMode] = useState<ChatApiMode>(defaultApiMode);
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

  // Initialization
  useEffect(() => {
    let mounted = true;
    
    void (async () => {
      try {
        const [bootstrap, nextCollections] = await Promise.all([
          fetchChatBootstrap("ghostdash"),
          fetchCollections(),
        ]);
        const nextAgents = bootstrap.agents;
        
        if (!mounted) return;
        
        setAgents(nextAgents);
        setCollections(nextCollections);
        
        const targetAgent =
          nextAgents.find((a) => a.id === bootstrap.default_agent_id) ??
          nextAgents.find((a) => a.is_default) ??
          nextAgents[0] ??
          null;
        if (!targetAgent) return;
        
        setActiveAgentId(targetAgent.id);
        const nextConversations = await fetchAgentConversations(targetAgent.id);
        
        if (!mounted) return;
        setConversations(nextConversations);
        
        const recentConversation = nextConversations[0] ?? null;
        if (!recentConversation) {
          setActiveConversationId(null);
          setLog([]);
          return;
        }
        
        setActiveConversationId(recentConversation.id);
        const messages = await fetchConversationMessages(recentConversation.id);
        
        if (!mounted) return;
        setLog(
          messages.map((entry) => ({
            id: entry.id,
            role: entry.role,
            text: entry.content,
            queryMode: entry.query_mode ?? undefined,
            citations: entry.citations,
          }))
        );
        
        await refreshUploadsInternal(recentConversation.id, nextCollections);
      } catch (err) {
        console.error("Failed to initialize chat engine", err);
      }
    })();
    
    return () => {
      mounted = false;
      abortRef.current?.abort();
    };
  }, []);

  const updateUploadCollectionDefaults = useCallback((nextUploads: ChatUpload[], nextCollections: Collection[]) => {
    setSelectedCollectionByUpload((current) => {
      const fallbackId = nextCollections[0]?.id ?? "";
      const next = { ...current };
      for (const upload of nextUploads) {
        if (next[upload.id]) continue;
        next[upload.id] = upload.collection_id ?? fallbackId;
      }
      return next;
    });
  }, []);

  const refreshUploadsInternal = useCallback(async (conversationId: string | null, nextCollections: Collection[] = collections) => {
    if (!conversationId) {
      setUploads([]);
      return;
    }
    try {
      const nextUploads = await fetchConversationUploads(conversationId);
      setUploads(nextUploads);
      updateUploadCollectionDefaults(nextUploads, nextCollections);
    } catch (err) {
      console.error("Failed to refresh uploads", err);
    }
  }, [collections, updateUploadCollectionDefaults]);

  const loadConversation = useCallback(async (agentId: string, conversationId: string | null) => {
    setActiveAgentId(agentId);
    setActiveConversationId(conversationId);
    if (!conversationId) {
      setLog([]);
      setUploads([]);
      return;
    }
    try {
      const messages = await fetchConversationMessages(conversationId);
      setLog(
        messages.map((entry) => ({
          id: entry.id,
          role: entry.role,
          text: entry.content,
          queryMode: entry.query_mode ?? undefined,
          citations: entry.citations,
        }))
      );
      await refreshUploadsInternal(conversationId);
    } catch (err) {
      console.error("Failed to load conversation", err);
    }
  }, [refreshUploadsInternal]);

  const refreshConversations = useCallback(async (agentId: string, preferredConversationId?: string | null) => {
    try {
      const nextConversations = await fetchAgentConversations(agentId);
      setConversations(nextConversations);
      const nextConversation = nextConversations.find((entry) => entry.id === preferredConversationId) ?? nextConversations[0] ?? null;
      await loadConversation(agentId, nextConversation?.id ?? null);
    } catch (err) {
      console.error("Failed to refresh conversations", err);
    }
  }, [loadConversation]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || busy || !activeAgentId || sendLockRef.current) {
      return false;
    }
    const userText = text.trim();
    const assistantId = crypto.randomUUID();
    
    sendLockRef.current = true;
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
        apiMode: sessionApiMode,
        llmModelId: sessionLlmModelId.trim() || null,
        agentId: activeAgentId,
        conversationId: activeConversationId ?? undefined,
        useApprovedWeb,
        signal: controller.signal,
        onStart: ({ query_mode, conversation_id }) => {
          if (conversation_id && conversation_id !== activeConversationId) {
            setActiveConversationId(conversation_id);
            void refreshUploadsInternal(conversation_id).catch(() => null);
          }
          setLog((items) =>
            items.map((entry) => (entry.id === assistantId ? { ...entry, queryMode: query_mode } : entry))
          );
        },
        onDelta: (delta) => {
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId ? { ...entry, text: `${entry.text}${delta}` } : entry
            )
          );
        },
        onDone: async ({ citations, conversation_id, usage }) => {
          setLog((items) =>
            items.map((entry) => (entry.id === assistantId ? { ...entry, citations } : entry))
          );
          if (usage && typeof usage.total_tokens === "number") {
            setLlmTokenTotal((n) => n + usage.total_tokens);
          }
          await refreshConversations(activeAgentId, conversation_id ?? activeConversationId);
        },
      });
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setLog((items) =>
          items.map((entry) =>
            entry.id === assistantId ? { ...entry, text: `Error: ${String(error)}` } : entry
          )
        );
      }
    } finally {
      abortRef.current = null;
      sendLockRef.current = false;
      setBusy(false);
    }
    return true;
  }, [
    busy,
    activeAgentId,
    sessionApiMode,
    sessionLlmModelId,
    activeConversationId,
    useApprovedWeb,
    refreshUploadsInternal,
    refreshConversations,
  ]);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sendLockRef.current = false;
    setBusy(false);
  }, []);

  const clearChat = useCallback(() => {
    setActiveConversationId(null);
    setLog([]);
    setUploads([]);
    setLlmTokenTotal(0);
  }, []);

  const changeAgent = useCallback((agentId: string) => {
    void (async () => {
      try {
        const nextConversations = await fetchAgentConversations(agentId);
        setConversations(nextConversations);
        const nextConversation = nextConversations[0] ?? null;
        await loadConversation(agentId, nextConversation?.id ?? null);
      } catch (err) {
        console.error("Failed to change agent", err);
      }
    })();
  }, [loadConversation]);

  // Upload Handlers
  const handleStageUpload = useCallback(async (file: File) => {
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
      await refreshUploadsInternal(activeConversationId);
      setUploadStatus(
        upload.error_message
          ? `${upload.filename} uploaded. Chat preview extraction had a warning, but you can still use it or save it to knowledge.`
          : `${upload.filename} uploaded. Choose whether it stays conversation-only or becomes saved agent knowledge.`
      );
    } catch (error) {
      setUploadStatus(`Upload failed: ${String(error)}`);
    } finally {
      setUploadBusy(false);
    }
  }, [activeConversationId, activeAgentId, uploadLane, refreshUploadsInternal]);

  const handleConversationOnly = useCallback(async (uploadId: string) => {
    setUploadBusy(true);
    try {
      await decideChatUpload({ uploadId, persistenceMode: "conversation_only" });
      await refreshUploadsInternal(activeConversationId);
      setUploadStatus("The file is now available only inside this conversation and will not be indexed into shared knowledge.");
    } catch (error) {
      setUploadStatus(`Could not update upload decision: ${String(error)}`);
    } finally {
      setUploadBusy(false);
    }
  }, [activeConversationId, refreshUploadsInternal]);

  const handleSaveDecision = useCallback(async (uploadId: string) => {
    setUploadBusy(true);
    try {
      await decideChatUpload({ uploadId, persistenceMode: "save_to_knowledge" });
      await refreshUploadsInternal(activeConversationId);
      setUploadStatus("Knowledge persistence requested. Pick the collection that should own this file before indexing starts.");
    } catch (error) {
      setUploadStatus(`Could not stage knowledge save: ${String(error)}`);
    } finally {
      setUploadBusy(false);
    }
  }, [activeConversationId, refreshUploadsInternal]);

  const handleConfirmCollection = useCallback(async (upload: ChatUpload) => {
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
      await refreshUploadsInternal(activeConversationId);
      if (onSyncRequest) {
        await onSyncRequest(updated.collection_slug ?? selectedCollection.slug);
      }
      await refreshUploadsInternal(activeConversationId);
      setUploadStatus(`${upload.filename} is now attached to ${updated.collection_slug ?? selectedCollection.slug} and has been queued for indexing.`);
    } catch (error) {
      setUploadStatus(`Could not save file into knowledge: ${String(error)}`);
    } finally {
      setUploadBusy(false);
    }
  }, [collections, selectedCollectionByUpload, activeConversationId, onSyncRequest, refreshUploadsInternal]);

  const webTool = activeAgent?.runtime_profile.tool_policy_config.tools.find((tool) => tool.id === "web") ?? null;
  const approvedWebConfigured = Boolean(webTool?.enabled && (webTool.allowed_urls?.length ?? 0) > 0);

  useEffect(() => {
    if (!approvedWebConfigured) {
      setUseApprovedWeb(false);
    }
  }, [approvedWebConfigured]);

  return {
    // State
    log,
    agents,
    collections,
    conversations,
    activeAgentId,
    activeAgent,
    activeConversationId,
    uploads,
    uploadLane,
    uploadStatus,
    uploadBusy,
    selectedCollectionByUpload,
    useApprovedWeb,
    busy,
    approvedWebConfigured,
    webTool,
    sessionApiMode,
    sessionLlmModelId,
    llmTokenTotal,

    // Actions
    sendMessage,
    stopGeneration,
    clearChat,
    changeAgent,
    loadConversation,
    setUploadLane,
    setSelectedCollectionByUpload,
    setUseApprovedWeb,
    setSessionApiMode,
    setSessionLlmModelId,
    handleStageUpload,
    handleConversationOnly,
    handleSaveDecision,
    handleConfirmCollection,
  };
}
