import { useEffect, useRef, useState, useCallback } from "react";
import {
  approveConversationFragment,
  type AgentProfile,
  type ChatApiMode,
  type ChatUsage,
  type ChatDocxMode,
  type DocxArtifact,
  type DocxDiagnostic,
  type ChatToolEvent,
  type LlmIoPayload,
  type ChatUpload,
  type Collection,
  type ConversationMode,
  type ConversationSummary,
  type DocumentFrame,
  type RequestedLane,
  type RouteDecision,
  type WorkflowMode,
  createConversation,
  decideChatUpload,
  fetchAgentConversations,
  fetchChatBootstrap,
  fetchCollections,
  fetchConversationDocumentFrame,
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
  toolEvents?: ChatToolEvent[];
  routeDecision?: RouteDecision | null;
  usage?: ChatUsage | null;
  llmIo?: LlmIoPayload | null;
};

export type BpRunFeedEvent = {
  id: string;
  ts: string;
  kind: "start" | "tool" | "route" | "audit" | "done";
  title: string;
  detail?: string;
  payload?: Record<string, unknown>;
};

function hydrateToolEvents(toolEvents: ChatToolEvent[] | undefined): ChatToolEvent[] {
  return [...(toolEvents ?? [])];
}

function sumConversationUsage(messages: Array<{ usage?: { total_tokens?: number } | null }>): number {
  return messages.reduce((total, entry) => total + (typeof entry.usage?.total_tokens === "number" ? entry.usage.total_tokens : 0), 0);
}

function deriveLlmIoFromUsage(usage: ChatUsage | null | undefined): LlmIoPayload | null {
  if (!usage) return null;
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    input_first_text: "",
    input_last_text: "",
  };
}

type UseChatEngineOptions = {
  /** Fallback before agents load; session controls reset from the active agent when it changes. */
  defaultApiMode?: ChatApiMode;
  defaultConversationMode?: ConversationMode;
  defaultWorkflowMode?: WorkflowMode;
  onSyncRequest?: (corpusSlug?: string) => Promise<void>;
};

export function useChatEngine({
  defaultApiMode = "responses",
  defaultConversationMode = "quick",
  defaultWorkflowMode = "standard",
  onSyncRequest,
}: UseChatEngineOptions) {
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
  const [documentFrame, setDocumentFrame] = useState<DocumentFrame | null>(null);
  const [documentDecisionByMessage, setDocumentDecisionByMessage] = useState<Record<string, "approved" | "rejected">>({});
  
  const abortRef = useRef<AbortController | null>(null);
  const sendLockRef = useRef(false);
  const activeAgent = agents.find((entry) => entry.id === activeAgentId) ?? null;
  const [sessionApiMode, setSessionApiMode] = useState<ChatApiMode>(defaultApiMode);
  const [sessionConversationMode, setSessionConversationMode] = useState<ConversationMode>(defaultConversationMode);
  const [sessionWorkflowMode, setSessionWorkflowMode] = useState<WorkflowMode>(defaultWorkflowMode);
  const [sessionLlmModelId, setSessionLlmModelId] = useState("");
  const [llmTokenTotal, setLlmTokenTotal] = useState(0);
  const [sessionDocxMode, setSessionDocxMode] = useState<ChatDocxMode>({
    enabled: false,
    template_id: null,
    operation: "preview",
    binding_overrides: {},
  });
  const [docxArtifacts, setDocxArtifacts] = useState<DocxArtifact[]>([]);
  const [docxDiagnostics, setDocxDiagnostics] = useState<DocxDiagnostic[]>([]);
  const [lastLlmIo, setLastLlmIo] = useState<LlmIoPayload | null>(null);
  const [bpRunFeed, setBpRunFeed] = useState<BpRunFeedEvent[]>([]);

  useEffect(() => {
    const agent = agents.find((entry) => entry.id === activeAgentId);
    if (!agent) return;
    setSessionApiMode(agent.runtime_profile.llm_config.api_mode);
    setSessionConversationMode(agent.runtime_profile.guardrails_config.conversation_mode ?? defaultConversationMode);
    setSessionLlmModelId(agent.runtime_profile.llm_config.model_id);
  }, [activeAgentId, agents, defaultConversationMode]);

  useEffect(() => {
    setLlmTokenTotal(0);
    setDocxArtifacts([]);
    setDocxDiagnostics([]);
    setLastLlmIo(null);
    setBpRunFeed([]);
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
        setSessionWorkflowMode(bootstrap.default_workflow_mode ?? defaultWorkflowMode);
        
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
          setLlmTokenTotal(0);
          setDocumentFrame(null);
          setDocumentDecisionByMessage({});
          setDocxArtifacts([]);
          setDocxDiagnostics([]);
          setLastLlmIo(null);
          setBpRunFeed([]);
          return;
        }
        
        setActiveConversationId(recentConversation.id);
        setSessionConversationMode(recentConversation.conversation_mode ?? defaultConversationMode);
        setSessionWorkflowMode(recentConversation.workflow_mode ?? defaultWorkflowMode);
        const messages = await fetchConversationMessages(recentConversation.id);
        
        if (!mounted) return;
        setLog(
          messages.map((entry) => ({
            id: entry.id,
            role: entry.role,
            text: entry.content,
            queryMode: entry.query_mode ?? undefined,
            citations: entry.citations,
            toolEvents: hydrateToolEvents(entry.tool_events),
            routeDecision: entry.route_decision ?? null,
            usage: entry.usage ?? null,
            llmIo: deriveLlmIoFromUsage(entry.usage),
          }))
        );
        setLlmTokenTotal(sumConversationUsage(messages));
        const lastAssistant = [...messages].reverse().find((entry) => entry.role === "assistant");
        setLastLlmIo(deriveLlmIoFromUsage(lastAssistant?.usage));
        setDocumentDecisionByMessage({});
        if (recentConversation.document_frame_id) {
          try {
            setDocumentFrame(await fetchConversationDocumentFrame(recentConversation.id));
          } catch {
            setDocumentFrame(null);
          }
        } else {
          setDocumentFrame(null);
        }
        
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
      setLlmTokenTotal(0);
      setDocumentFrame(null);
      setDocumentDecisionByMessage({});
      setDocxArtifacts([]);
      setDocxDiagnostics([]);
      setLastLlmIo(null);
      setBpRunFeed([]);
      setSessionWorkflowMode(defaultWorkflowMode);
      return;
    }
    try {
      const conversationSummary = conversations.find((entry) => entry.id === conversationId) ?? null;
      if (conversationSummary?.conversation_mode) {
        setSessionConversationMode(conversationSummary.conversation_mode);
      }
      if (conversationSummary?.workflow_mode) {
        setSessionWorkflowMode(conversationSummary.workflow_mode);
      }
      const messages = await fetchConversationMessages(conversationId);
      const latestConversationMode =
        [...messages].reverse().find((entry) => entry.conversation_mode)?.conversation_mode ?? conversationSummary?.conversation_mode;
      if (latestConversationMode) {
        setSessionConversationMode(latestConversationMode);
      }
      setLog(
        messages.map((entry) => ({
          id: entry.id,
          role: entry.role,
          text: entry.content,
          queryMode: entry.query_mode ?? undefined,
          citations: entry.citations,
          toolEvents: hydrateToolEvents(entry.tool_events),
          routeDecision: entry.route_decision ?? null,
          usage: entry.usage ?? null,
          llmIo: deriveLlmIoFromUsage(entry.usage),
        }))
      );
      setLlmTokenTotal(sumConversationUsage(messages));
      const lastAssistant = [...messages].reverse().find((entry) => entry.role === "assistant");
      setLastLlmIo(deriveLlmIoFromUsage(lastAssistant?.usage));
      setDocumentDecisionByMessage({});
      setDocxArtifacts([]);
      setDocxDiagnostics([]);
      if (conversationSummary?.document_frame_id) {
        try {
          setDocumentFrame(await fetchConversationDocumentFrame(conversationId));
        } catch {
          setDocumentFrame(null);
        }
      } else {
        setDocumentFrame(null);
      }
      await refreshUploadsInternal(conversationId);
    } catch (err) {
      console.error("Failed to load conversation", err);
    }
  }, [conversations, defaultConversationMode, defaultWorkflowMode, refreshUploadsInternal]);

  /** Updates sidebar/title metadata only — does not replace the in-memory message log. */
  const refreshConversationSummaries = useCallback(async (agentId: string) => {
    try {
      const nextConversations = await fetchAgentConversations(agentId);
      setConversations(nextConversations);
    } catch (err) {
      console.error("Failed to refresh conversation summaries", err);
    }
  }, []);

  const refreshConversations = useCallback(async (agentId: string, preferredConversationId?: string | null) => {
    try {
      const nextConversations = await fetchAgentConversations(agentId);
      setConversations(nextConversations);
      // When a conversation id is specified, never fall back to conversations[0] — that caused
      // wrong-thread reloads. If the list is briefly stale, still load by id.
      const resolvedId =
        preferredConversationId != null && preferredConversationId !== ""
          ? preferredConversationId
          : (nextConversations[0]?.id ?? null);
      await loadConversation(agentId, resolvedId);
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
    if (sessionWorkflowMode === "bp_mode") {
      setBpRunFeed([
        {
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          kind: "start",
          title: "BP run started",
          detail: userText,
        },
      ]);
    }
    
    sendLockRef.current = true;
    setBusy(true);
    setLog((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", text: userText },
      { id: assistantId, role: "assistant", text: "", toolEvents: [], usage: null, llmIo: null },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat({
        message: userText,
        apiMode: sessionApiMode,
        conversationMode: sessionConversationMode,
        workflowMode: sessionWorkflowMode,
        agentId: activeAgentId,
        conversationId: activeConversationId ?? undefined,
        useApprovedWeb,
        docxMode: sessionDocxMode,
        signal: controller.signal,
        onStart: ({ query_mode, conversation_id, tool_events, workflow_mode, route_decision, docx_artifacts, docx_diagnostics }) => {
          setSessionWorkflowMode(workflow_mode);
          setDocxArtifacts(docx_artifacts ?? []);
          setDocxDiagnostics(docx_diagnostics ?? []);
          if (conversation_id && conversation_id !== activeConversationId) {
            setActiveConversationId(conversation_id);
            void refreshUploadsInternal(conversation_id).catch(() => null);
          }
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId
                ? {
                    ...entry,
                    queryMode: query_mode,
                    toolEvents: tool_events ?? entry.toolEvents ?? [],
                    routeDecision: route_decision ?? entry.routeDecision ?? null,
                  }
                : entry
            )
          );
          if (workflow_mode === "bp_mode") {
            setBpRunFeed((items) => [
              ...items,
              {
                id: crypto.randomUUID(),
                ts: new Date().toISOString(),
                kind: "route",
                title: `Route: ${route_decision?.route_type ?? "workers"}`,
                detail: route_decision?.rationale_summary ?? "BP orchestration route resolved.",
                payload: (route_decision ?? undefined) as Record<string, unknown> | undefined,
              },
            ]);
            for (const event of tool_events ?? []) {
              setBpRunFeed((items) => [
                ...items,
                {
                  id: crypto.randomUUID(),
                  ts: new Date().toISOString(),
                  kind: "tool",
                  title: `${event.tool_id} (${event.status})`,
                  detail: event.summary ?? event.operation ?? "",
                  payload: event.payload,
                },
              ]);
            }
          }
        },
        onToolEvent: ({ tool_event }) => {
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId
                ? { ...entry, toolEvents: [...(entry.toolEvents ?? []), tool_event] }
                : entry
            )
          );
          if (sessionWorkflowMode === "bp_mode") {
            setBpRunFeed((items) => [
              ...items,
              {
                id: crypto.randomUUID(),
                ts: new Date().toISOString(),
                kind: tool_event.tool_id === "agent.bp_auditor" ? "audit" : "tool",
                title: `${tool_event.tool_id} (${tool_event.status})`,
                detail: tool_event.summary ?? tool_event.operation ?? "",
                payload: tool_event.payload,
              },
            ]);
          }
        },
        onDelta: (delta) => {
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId ? { ...entry, text: `${entry.text}${delta}` } : entry
            )
          );
        },
        onDone: async ({ citations, usage, llm_io, tool_events, workflow_mode, route_decision, docx_artifacts, docx_diagnostics }) => {
          setSessionWorkflowMode(workflow_mode);
          setDocxArtifacts(docx_artifacts ?? []);
          setDocxDiagnostics(docx_diagnostics ?? []);
          const usageIo = llm_io ?? deriveLlmIoFromUsage(usage);
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId
                ? {
                    ...entry,
                    citations,
                    toolEvents: tool_events ?? entry.toolEvents ?? [],
                    routeDecision: route_decision ?? entry.routeDecision ?? null,
                    usage: usage ?? entry.usage ?? null,
                    llmIo: usageIo ?? entry.llmIo ?? null,
                  }
                : entry
            )
          );
          if (usage && typeof usage.total_tokens === "number") {
            setLlmTokenTotal((n) => n + usage.total_tokens);
          }
          setLastLlmIo(usageIo);
          if (workflow_mode === "bp_mode") {
            const bpAudit = (route_decision?.tool_expectations as Record<string, unknown> | undefined)?.bp_audit as
              | Record<string, unknown>
              | undefined;
            if (bpAudit) {
              setBpRunFeed((items) => [
                ...items,
                {
                  id: crypto.randomUUID(),
                  ts: new Date().toISOString(),
                  kind: "audit",
                  title: `Audit ${bpAudit.hard_fail ? "failed" : "passed"}`,
                  detail: String(bpAudit.findings ?? ""),
                  payload: bpAudit,
                },
              ]);
            }
            setBpRunFeed((items) => [
              ...items,
              {
                id: crypto.randomUUID(),
                ts: new Date().toISOString(),
                kind: "done",
                title: "BP run completed",
                detail: `Tool events: ${tool_events?.length ?? 0}, citations: ${citations?.length ?? 0}`,
              },
            ]);
          }
          // Do not call loadConversation here — refetching messages right after send can race the
          // server and replace the optimistic log with stale DB rows (e.g. user edits "7 days" but UI shows "5 days").
          await refreshConversationSummaries(activeAgentId);
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
    sessionConversationMode,
    sessionWorkflowMode,
    sessionDocxMode,
    activeConversationId,
    useApprovedWeb,
    refreshUploadsInternal,
    refreshConversationSummaries,
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
    setDocumentFrame(null);
    setDocumentDecisionByMessage({});
    setDocxArtifacts([]);
    setDocxDiagnostics([]);
    setLastLlmIo(null);
    setBpRunFeed([]);
    setSessionWorkflowMode(defaultWorkflowMode);
  }, [defaultWorkflowMode]);

  const resolveWorkflowAgent = useCallback((workflowMode: WorkflowMode) => {
    const byName = (name: string) => agents.find((agent) => agent.name.trim().toLowerCase() === name.toLowerCase()) ?? null;
    if (workflowMode === "data_collector") {
      return byName("Business Strategist") ?? activeAgent ?? agents[0] ?? null;
    }
    if (workflowMode === "documenter") {
      return byName("Business Marketing & Strategy Documenter") ?? activeAgent ?? agents[0] ?? null;
    }
    if (workflowMode === "case_framing") {
      return (
        byName("Case Framing Agent") ??
        byName("Business Strategist") ??
        activeAgent ??
        agents[0] ??
        null
      );
    }
    if (workflowMode === "evidence_retrieval") {
      return (
        byName("Evidence Retrieval Agent") ??
        byName("Business Strategist") ??
        activeAgent ??
        agents[0] ??
        null
      );
    }
    if (workflowMode === "bp_mode") {
      return (
        byName("Lead Enterprise Technical Business Architect") ??
        byName("Llama Architect") ??
        activeAgent ??
        agents[0] ??
        null
      );
    }
    return activeAgent ?? agents[0] ?? null;
  }, [activeAgent, agents]);

  const startWorkflowConversation = useCallback(async (workflowMode: WorkflowMode) => {
    const targetAgent = resolveWorkflowAgent(workflowMode);
    if (!targetAgent) {
      return null;
    }
    const created = await createConversation({
      agentId: targetAgent.id,
      workflowMode,
      conversationMode:
        workflowMode === "documenter"
          ? "board"
          : workflowMode === "data_collector" ||
              workflowMode === "case_framing" ||
              workflowMode === "evidence_retrieval" ||
              workflowMode === "bp_mode"
            ? "working_session"
            : defaultConversationMode,
      sourceConversationId: workflowMode === "standard" ? null : activeConversationId ?? null,
    });
    if (targetAgent.id !== activeAgentId) {
      setActiveAgentId(targetAgent.id);
    }
    const nextConversations = await fetchAgentConversations(targetAgent.id);
    setConversations(nextConversations);
    setSessionWorkflowMode(created.workflow_mode);
    await loadConversation(targetAgent.id, created.id);
    return created;
  }, [activeAgentId, activeConversationId, defaultConversationMode, loadConversation, resolveWorkflowAgent]);

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

  const approveMessageForDocument = useCallback(async (messageId: string, fragmentType: "snippet" | "paragraph" | "mini_analysis" | "scorecard" | "graph_idea" = "snippet") => {
    if (!activeConversationId) {
      return null;
    }
    const frame = await approveConversationFragment({
      conversationId: activeConversationId,
      sourceMessageId: messageId,
      fragmentType,
    });
    setDocumentFrame(frame);
    setDocumentDecisionByMessage((current) => ({ ...current, [messageId]: "approved" }));
    return frame;
  }, [activeConversationId]);

  const rejectMessageForDocument = useCallback((messageId: string) => {
    setDocumentDecisionByMessage((current) => ({ ...current, [messageId]: "rejected" }));
  }, []);

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
    documentFrame,
    documentDecisionByMessage,
    approvedWebConfigured,
    webTool,
    sessionApiMode,
    sessionConversationMode,
    sessionWorkflowMode,
    sessionLlmModelId,
    sessionDocxMode,
    llmTokenTotal,
    lastLlmIo,
    docxArtifacts,
    docxDiagnostics,
    bpRunFeed,

    // Actions
    sendMessage,
    stopGeneration,
    clearChat,
    startWorkflowConversation,
    changeAgent,
    loadConversation,
    refreshConversations,
    refreshConversationSummaries,
    approveMessageForDocument,
    rejectMessageForDocument,
    setUploadLane,
    setSelectedCollectionByUpload,
    setUseApprovedWeb,
    setSessionApiMode,
    setSessionConversationMode,
    setSessionWorkflowMode,
    setSessionLlmModelId,
    setSessionDocxMode,
    handleStageUpload,
    handleConversationOnly,
    handleSaveDecision,
    handleConfirmCollection,
  };
}
