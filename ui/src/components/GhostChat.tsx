import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentProfile,
  ChatApiMode,
  ChatUsage,
  ChatToolEvent,
  ChatUpload,
  Collection,
  ConversationMode,
  ConversationSummary,
  DocumentFrame,
  ElevenLabsMasteringPayload,
  LlmIoPayload,
  RequestedLane,
  RouteDecision,
  VoiceProviderStatus,
  WorkflowMode,
} from "../api";
import {
  approveConversationFragment,
  buildVoiceStreamUrl,
  createConversation,
  decideChatUpload,
  fetchAgentConversations,
  fetchChatBootstrap,
  fetchCollections,
  fetchConversationDocumentFrame,
  fetchConversationMessages,
  fetchConversationUploads,
  fetchVoiceProviderVoices,
  stageConversationUpload,
  streamChat,
} from "../api";
import { createElevenLabsTtsQueue } from "../lib/elevenlabsTtsQueue";
import {
  cloneStreamingState,
  defaultElevenLabsMasteringSettings,
  resolveMasteringForAgent,
  pickVoiceIdForAgent,
  readGhostChatStreamingState,
  updateMasteringForAgent,
  writeGhostChatStreamingState,
  type GhostChatStreamingState,
} from "../lib/ghostChatStreamingSettings";
import {
  createSpeechRecognition,
  getBrowserVoiceCapabilities,
  type BrowserVoiceCapabilities,
  type SpeechRecognitionLike,
} from "../lib/voice";
import { CloseIcon, MessageSquareIcon, PlusIcon, SendIcon } from "./ReferenceIcons";
import AgentToolTrace, { shouldShowMultiAgentToolTrace } from "./chat/AgentToolTrace";
import ApryseDocumentPanel from "./chat/ApryseDocumentPanel";

type ChatEntry = {
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

function randomSeed() {
  return Math.floor(Math.random() * 2_000_000_000);
}

function toMasteringPayload(
  value: ReturnType<typeof defaultElevenLabsMasteringSettings>,
): ElevenLabsMasteringPayload {
  return {
    model_id: value.model_id,
    language_code: value.language_code,
    seed: value.seed,
    previous_text: value.previous_text,
    next_text: value.next_text,
    apply_text_normalization: value.apply_text_normalization,
    voice_settings: {
      stability: value.voice_settings.stability,
      similarity_boost: value.voice_settings.similarity_boost,
      style: value.voice_settings.style,
      use_speaker_boost: value.voice_settings.use_speaker_boost,
      speed: value.voice_settings.speed,
    },
    pronunciation_dictionary_locators: value.pronunciation_dictionary_locators.map((entry) => ({ ...entry })),
    pronunciation_replacements: value.pronunciation_replacements.map((entry) => ({ ...entry })),
  };
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
  const [frameContextTitle, setFrameContextTitle] = useState("Tables / Context");
  const [frameContextContent, setFrameContextContent] = useState("");
  const [frameContextBusy, setFrameContextBusy] = useState(false);
  const [documentFrame, setDocumentFrame] = useState<DocumentFrame | null>(null);
  const [messageApprovalState, setMessageApprovalState] = useState<Record<string, "approved" | "rejected">>({});
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeAgent = agents.find((entry) => entry.id === activeAgentId) ?? null;
  const [sessionApiMode, setSessionApiMode] = useState<ChatApiMode>(apiMode);
  const [sessionConversationMode, setSessionConversationMode] = useState<ConversationMode>("quick");
  const [sessionWorkflowMode, setSessionWorkflowMode] = useState<WorkflowMode>("standard");
  const [sessionLlmModelId, setSessionLlmModelId] = useState("");
  const [llmTokenTotal, setLlmTokenTotal] = useState(0);
  const [lastLlmIo, setLastLlmIo] = useState<LlmIoPayload | null>(null);
  const [sessionDocxMode, setSessionDocxMode] = useState({
    enabled: false,
    template_id: "",
    operation: "preview" as "preview" | "finalize",
    binding_overrides: {} as Record<string, unknown>,
  });
  const [docxArtifacts, setDocxArtifacts] = useState<Array<{ kind: "docx" | "pdf" | "html"; uri: string; label?: string | null }>>([]);
  const [docxDiagnostics, setDocxDiagnostics] = useState<Array<{ code: string; message: string; field?: string | null }>>([]);
  const [voiceCapabilities, setVoiceCapabilities] = useState<BrowserVoiceCapabilities>({
    speechRecognition: false,
    speechSynthesis: false,
    mediaDevices: false,
  });
  const [streamDraft, setStreamDraft] = useState<GhostChatStreamingState>(() => readGhostChatStreamingState());
  const [streamSaved, setStreamSaved] = useState<GhostChatStreamingState>(() => readGhostChatStreamingState());
  const [masteringPanelOpen, setMasteringPanelOpen] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [streamPreflightOpen, setStreamPreflightOpen] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [voiceProviderStatus, setVoiceProviderStatus] = useState<VoiceProviderStatus | null>(null);
  const [callState, setCallState] = useState<"idle" | "connecting" | "listening" | "thinking" | "speaking" | "interrupted" | "error" | "closed">("idle");
  const [callTranscript, setCallTranscript] = useState("");
  const [callError, setCallError] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const callSocketRef = useRef<WebSocket | null>(null);
  const callMediaStreamRef = useRef<MediaStream | null>(null);
  const ttsRef = useRef<ReturnType<typeof createElevenLabsTtsQueue> | null>(null);
  const ttsEnabledRef = useRef(false);
  const ttsVoiceIdRef = useRef("");
  const ttsMasteringRef = useRef<ElevenLabsMasteringPayload | null>(null);
  if (!ttsRef.current) {
    ttsRef.current = createElevenLabsTtsQueue({
      getEnabled: () => ttsEnabledRef.current,
      getVoiceId: () => ttsVoiceIdRef.current,
      getMastering: () => ttsMasteringRef.current,
      onStatus: (message) => setVoiceStatus(message),
    });
  }
  const streamSettingsDirty = JSON.stringify(streamDraft) !== JSON.stringify(streamSaved);
  const resolvedElevenLabsVoiceId = useMemo(() => {
    if (!activeAgentId || !voiceProviderStatus?.configured || !voiceProviderStatus.voices.length) return "";
    const valid = new Set(voiceProviderStatus.voices.map((v) => v.voice_id));
    const fallback = voiceProviderStatus.default_voice_id || voiceProviderStatus.voices[0]?.voice_id || "";
    return pickVoiceIdForAgent({
      agentId: activeAgentId,
      agentVoiceId: activeAgent?.voice_id ?? "",
      state: streamDraft,
      validVoiceIds: valid,
      fallbackVoiceId: fallback,
    });
  }, [activeAgentId, activeAgent, streamDraft, voiceProviderStatus]);
  const activeMastering = useMemo(
    () => resolveMasteringForAgent(streamDraft, activeAgentId),
    [streamDraft, activeAgentId],
  );
  const savedMastering = useMemo(
    () => resolveMasteringForAgent(streamSaved, activeAgentId),
    [streamSaved, activeAgentId],
  );
  const masteringDirty = JSON.stringify(activeMastering) !== JSON.stringify(savedMastering);
  const streamMasteringPayload = useMemo(() => toMasteringPayload(activeMastering), [activeMastering]);
  const conversationModes: Array<{ id: ConversationMode; label: string; hint: string }> = [
    { id: "quick", label: "Quick", hint: "Fast first pass" },
    { id: "board", label: "Board", hint: "Full executive answer" },
    { id: "working_session", label: "Working Session", hint: "Coach through the data" },
  ];

  useEffect(() => {
    const agent = agents.find((entry) => entry.id === activeAgentId);
    if (!agent) return;
    setSessionApiMode(agent.runtime_profile.llm_config.api_mode);
    setSessionConversationMode(agent.runtime_profile.guardrails_config.conversation_mode ?? "quick");
    setSessionLlmModelId(agent.runtime_profile.llm_config.model_id);
  }, [activeAgentId, agents]);

  useEffect(() => {
    setLlmTokenTotal(0);
    setLastLlmIo(null);
  }, [activeConversationId]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    setVoiceCapabilities(getBrowserVoiceCapabilities());
  }, []);

  useEffect(() => {
    if (!open) return;
    void fetchVoiceProviderVoices()
      .then((status) => {
        setVoiceProviderStatus(status);
      })
      .catch((error) => {
        setVoiceProviderStatus({
          configured: false,
          provider: "elevenlabs",
          default_voice_id: null,
          voices: [],
          message: `Voice provider unavailable: ${String(error)}`,
        });
      });
  }, [open]);

  useEffect(() => {
    ttsEnabledRef.current = streamDraft.speakResponses;
    ttsVoiceIdRef.current = resolvedElevenLabsVoiceId;
    ttsMasteringRef.current = streamMasteringPayload;
    if (!streamDraft.speakResponses) {
      ttsRef.current?.stop();
    }
  }, [streamDraft.speakResponses, resolvedElevenLabsVoiceId, streamMasteringPayload]);

  useEffect(() => {
    if (!streamDraft.autoSaveMastering) return;
    writeGhostChatStreamingState(streamDraft);
    setStreamSaved(cloneStreamingState(streamDraft));
  }, [streamDraft]);

  useEffect(() => {
    if (!callSocketRef.current) return;
    if (callState === "closed" || callState === "error" || callState === "idle") return;
    try {
      callSocketRef.current.send(
        JSON.stringify({
          type: "settings_update",
          voice_id: resolvedElevenLabsVoiceId,
          mastering: streamMasteringPayload,
        }),
      );
    } catch {
      // live stream update is best-effort
    }
  }, [streamMasteringPayload, resolvedElevenLabsVoiceId, callState]);

  /** When switching agents, seed a default ElevenLabs pick into draft if none stored. */
  useEffect(() => {
    if (!open || !activeAgentId || !voiceProviderStatus?.configured || !voiceProviderStatus.voices.length) return;
    setStreamDraft((d) => {
      if (d.voiceByAgentId[activeAgentId]) return d;
      const valid = new Set(voiceProviderStatus.voices.map((v) => v.voice_id));
      const agent = agents.find((a) => a.id === activeAgentId);
      const fallback = voiceProviderStatus.default_voice_id || voiceProviderStatus.voices[0]?.voice_id || "";
      const v = pickVoiceIdForAgent({
        agentId: activeAgentId,
        agentVoiceId: agent?.voice_id ?? "",
        state: d,
        validVoiceIds: valid,
        fallbackVoiceId: fallback,
      });
      if (!v) return d;
      return { ...d, voiceByAgentId: { ...d.voiceByAgentId, [activeAgentId]: v } };
    });
  }, [open, activeAgentId, voiceProviderStatus, agents]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      ttsRef.current?.stop();
      callSocketRef.current?.close();
      callMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
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
      setSessionConversationMode(bootstrap.runtime_defaults.conversation_mode ?? "quick");
      setSessionWorkflowMode(bootstrap.default_workflow_mode ?? "standard");
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
        setLlmTokenTotal(0);
        setLastLlmIo(null);
        setDocumentFrame(null);
        setMessageApprovalState({});
        return;
      }
      setActiveConversationId(recentConversation.id);
      setSessionConversationMode(recentConversation.conversation_mode ?? bootstrap.runtime_defaults.conversation_mode ?? "quick");
      setSessionWorkflowMode(recentConversation.workflow_mode ?? bootstrap.default_workflow_mode ?? "standard");
      const messages = await fetchConversationMessages(recentConversation.id);
      const latestConversationMode =
        [...messages].reverse().find((entry) => entry.conversation_mode)?.conversation_mode ?? recentConversation.conversation_mode;
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
        })),
      );
      setLlmTokenTotal(sumConversationUsage(messages));
      const lastAssistant = [...messages].reverse().find((entry) => entry.role === "assistant");
      setLastLlmIo(deriveLlmIoFromUsage(lastAssistant?.usage));
      if (recentConversation.document_frame_id) {
        try {
          setDocumentFrame(await fetchConversationDocumentFrame(recentConversation.id));
        } catch {
          setDocumentFrame(null);
        }
      } else {
        setDocumentFrame(null);
      }
      setMessageApprovalState({});
      await refreshUploads(recentConversation.id, nextCollections);
    })().catch(() => null);
  }, [open]);

  async function loadConversation(agentId: string, conversationId: string | null) {
    setActiveAgentId(agentId);
    setActiveConversationId(conversationId);
    if (!conversationId) {
      setLog([]);
      setUploads([]);
      setLlmTokenTotal(0);
      setLastLlmIo(null);
      setDocumentFrame(null);
      setMessageApprovalState({});
      setSessionWorkflowMode("standard");
      return;
    }
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
      })),
    );
    setLlmTokenTotal(sumConversationUsage(messages));
    const lastAssistant = [...messages].reverse().find((entry) => entry.role === "assistant");
    setLastLlmIo(deriveLlmIoFromUsage(lastAssistant?.usage));
    if (conversationSummary?.document_frame_id) {
      try {
        setDocumentFrame(await fetchConversationDocumentFrame(conversationId));
      } catch {
        setDocumentFrame(null);
      }
    } else {
      setDocumentFrame(null);
    }
    setMessageApprovalState({});
    await refreshUploads(conversationId);
  }

  function resolveWorkflowAgent(nextAgents: AgentProfile[], workflowMode: WorkflowMode): AgentProfile | null {
    const byName = (name: string) => nextAgents.find((agent) => agent.name.trim().toLowerCase() === name.toLowerCase()) ?? null;
    if (workflowMode === "data_collector") {
      return byName("Business Strategist") ?? byName("RE- Business Strategist") ?? nextAgents[0] ?? null;
    }
    if (workflowMode === "documenter") {
      return byName("Business Marketing & Strategy Documenter") ?? nextAgents[0] ?? null;
    }
    if (workflowMode === "case_framing") {
      return (
        byName("Case Framing Agent") ??
        byName("Business Strategist") ??
        byName("RE- Business Strategist") ??
        nextAgents[0] ??
        null
      );
    }
    if (workflowMode === "evidence_retrieval") {
      return (
        byName("Evidence Retrieval Agent") ??
        byName("Business Strategist") ??
        byName("RE- Business Strategist") ??
        nextAgents[0] ??
        null
      );
    }
    if (workflowMode === "bp_mode") {
      return byName("Lead Enterprise Technical Business Architect") ?? byName("Llama Architect") ?? nextAgents[0] ?? null;
    }
    return byName("GhostDASH Assistant") ?? nextAgents.find((agent) => agent.is_default) ?? nextAgents[0] ?? null;
  }

  async function startWorkflowConversation(workflowMode: WorkflowMode) {
    const targetAgent = resolveWorkflowAgent(agents, workflowMode);
    if (!targetAgent) return;
    const created = await createConversation({
      agentId: targetAgent.id,
      workflowMode,
      conversationMode:
        workflowMode === "documenter"
          ? "board"
          : workflowMode === "standard"
            ? "quick"
            : "working_session",
      sourceConversationId: workflowMode === "standard" ? null : activeConversationId ?? null,
    });
    const nextConversations = await fetchAgentConversations(targetAgent.id);
    setConversations(nextConversations);
    setSessionWorkflowMode(created.workflow_mode);
    await loadConversation(targetAgent.id, created.id);
  }

  async function refreshConversationSummaries(agentId: string) {
    const nextConversations = await fetchAgentConversations(agentId);
    setConversations(nextConversations);
  }

  function stopListening() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsListening(false);
  }

  function startListening() {
    if (isListening) {
      stopListening();
      return;
    }
    if (!voiceCapabilities.speechRecognition) {
      setVoiceStatus("Speech recognition is not supported in this browser.");
      return;
    }
    const recognition = createSpeechRecognition(activeAgent?.language ?? "en-AU");
    if (!recognition) {
      setVoiceStatus("Speech recognition is not available in this browser.");
      return;
    }
    let finalTranscript = "";
    recognition.onresult = (event) => {
      let interimTranscript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          finalTranscript += `${transcript} `;
        } else {
          interimTranscript += transcript;
        }
      }
      const nextText = `${finalTranscript}${interimTranscript}`.trim();
      if (nextText) {
        setMessage(nextText);
      }
    };
    recognition.onerror = (event) => {
      setVoiceStatus(`Mic error: ${event.error ?? "unknown"}`);
      setIsListening(false);
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
      setVoiceStatus(finalTranscript.trim() ? "Transcript ready to send." : "Listening stopped.");
    };
    recognitionRef.current = recognition;
    setVoiceStatus("Listening...");
    setIsListening(true);
    recognition.start();
  }

  function saveStreamingSettings() {
    writeGhostChatStreamingState(streamDraft);
    setStreamSaved(cloneStreamingState(streamDraft));
  }

  function revertStreamingSettings() {
    const reverted = cloneStreamingState(streamSaved);
    setStreamDraft(reverted);
    writeGhostChatStreamingState(reverted);
    setStreamSaved(reverted);
  }

  function patchActiveAgentMastering(
    updater: (current: ReturnType<typeof defaultElevenLabsMasteringSettings>) => ReturnType<typeof defaultElevenLabsMasteringSettings>,
  ) {
    if (!activeAgentId) return;
    setStreamDraft((current) => updateMasteringForAgent(current, activeAgentId, updater));
  }

  function saveMasteringPreset() {
    const name = presetNameDraft.trim();
    if (!name) return;
    const settings = activeMastering;
    setStreamDraft((current) => {
      const existing = current.presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase()) ?? null;
      const nextPreset = {
        id: existing?.id ?? crypto.randomUUID(),
        name,
        settings,
        updated_at: new Date().toISOString(),
      };
      const nextPresets = existing
        ? current.presets.map((preset) => (preset.id === existing.id ? nextPreset : preset))
        : [...current.presets, nextPreset];
      return { ...current, presets: nextPresets };
    });
    setPresetNameDraft("");
  }

  function applyMasteringPreset(presetId: string) {
    if (!activeAgentId) return;
    setStreamDraft((current) => {
      const preset = current.presets.find((entry) => entry.id === presetId);
      if (!preset) return current;
      return updateMasteringForAgent(current, activeAgentId, () => preset.settings);
    });
  }

  function removeMasteringPreset(presetId: string) {
    setStreamDraft((current) => ({
      ...current,
      presets: current.presets.filter((preset) => preset.id !== presetId),
    }));
  }

  function requestOpenStreamingPreflight() {
    setCallError("");
    if (!activeAgentId) {
      setCallError("Choose an agent before opening streaming.");
      return;
    }
    setStreamPreflightOpen(true);
  }

  function stopCall() {
    callSocketRef.current?.close();
    callSocketRef.current = null;
    callMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    callMediaStreamRef.current = null;
    setCallState("closed");
  }

  async function openStreamingCall() {
    if (!activeAgentId) {
      setCallError("Choose an agent before opening streaming.");
      return;
    }
    setCallError("");
    setCallTranscript("");
    setCallState("connecting");
    setStreamPreflightOpen(false);
    try {
      // Mic capture is optional here; missing devices should not block streaming playback/testing.
      if (voiceCapabilities.mediaDevices && navigator.mediaDevices?.getUserMedia) {
        try {
          callMediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (error) {
          setVoiceStatus(`Microphone unavailable; continuing without mic input (${String(error)}).`);
          callMediaStreamRef.current = null;
        }
      }
      const socket = new WebSocket(
        buildVoiceStreamUrl({
          agentId: activeAgentId,
          conversationId: activeConversationId,
          voiceId: resolvedElevenLabsVoiceId,
          mastering: streamMasteringPayload,
        }),
      );
      callSocketRef.current = socket;
      socket.onopen = () => {
        setCallState("listening");
        socket.send(
          JSON.stringify({
            type: "start",
            agent_id: activeAgentId,
            conversation_id: activeConversationId,
            voice_id: resolvedElevenLabsVoiceId,
            mastering: streamMasteringPayload,
          }),
        );
      };
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as { type?: string; status?: string; message?: string; transcript?: string };
          if (payload.transcript) {
            setCallTranscript((current) => `${current}${current ? "\n" : ""}${payload.transcript}`);
          }
          if (payload.type === "error") {
            setCallState("error");
            setCallError(payload.message ?? "Streaming voice connection failed.");
          } else if (payload.status === "thinking" || payload.status === "speaking" || payload.status === "interrupted") {
            setCallState(payload.status);
          }
          if (payload.message && payload.type !== "error") {
            setCallTranscript((current) => `${current}${current ? "\n" : ""}${payload.message}`);
          }
        } catch {
          setCallTranscript((current) => `${current}${current ? "\n" : ""}${String(event.data)}`);
        }
      };
      socket.onerror = () => {
        setCallState("error");
        setCallError("Streaming socket error.");
      };
      socket.onclose = () => {
        callMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        callMediaStreamRef.current = null;
        callSocketRef.current = null;
        setCallState((current) => (current === "error" ? "error" : "closed"));
      };
    } catch (error) {
      callMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      callMediaStreamRef.current = null;
      setCallState("error");
      setCallError(String(error));
    }
  }

  async function send() {
    if (!message.trim() || busy || !activeAgentId) return;
    ttsRef.current?.stop();
    const userText = message.trim();
    const assistantId = crypto.randomUUID();
    setMessage("");
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
          if (conversation_id) {
            setActiveConversationId(conversation_id);
            void refreshUploads(conversation_id).catch(() => null);
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
          ttsRef.current?.pushDelta(delta);
          setLog((items) =>
            items.map((entry) =>
              entry.id === assistantId ? { ...entry, text: `${entry.text}${delta}` } : entry,
            ),
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
            ),
          );
          if (usage && typeof usage.total_tokens === "number") {
            setLlmTokenTotal((n) => n + usage.total_tokens);
          }
          setLastLlmIo(usageIo);
          ttsRef.current?.flush();
          await refreshConversationSummaries(activeAgentId);
        },
      });
    } catch (error) {
      ttsRef.current?.stop();
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

  async function appendFrameContextNote() {
    if (!activeConversationId || !activeAgentId) return;
    const content = frameContextContent.trim();
    if (!content) return;
    const title = frameContextTitle.trim() || null;
    setFrameContextBusy(true);
    try {
      const frame = await approveConversationFragment({
        conversationId: activeConversationId,
        fragmentType: "note",
        title,
        content,
      });
      setDocumentFrame(frame);
      setFrameContextContent("");
    } catch (error) {
      setLog((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: `Error appending tables/context to document frame: ${String(error)}`,
          toolEvents: [],
          usage: null,
          llmIo: null,
        },
      ]);
    } finally {
      setFrameContextBusy(false);
    }
  }

  function handleClose() {
    abortRef.current?.abort();
    onClose();
  }

  async function approveMessageForDocument(messageId: string, fragmentType: "snippet" | "paragraph" | "mini_analysis" | "scorecard" | "graph_idea" = "snippet") {
    if (!activeConversationId) return;
    try {
      const frame = await approveConversationFragment({
        conversationId: activeConversationId,
        sourceMessageId: messageId,
        fragmentType,
      });
      setDocumentFrame(frame);
      setMessageApprovalState((current) => ({ ...current, [messageId]: "approved" }));
    } catch (error) {
      setUploadStatus(`Could not approve message for document: ${String(error)}`);
    }
  }

  function rejectMessageForDocument(messageId: string) {
    setMessageApprovalState((current) => ({ ...current, [messageId]: "rejected" }));
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
      {streamPreflightOpen && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="stream-preflight-title"
        >
          <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 id="stream-preflight-title" className="text-lg font-semibold text-slate-900">
              Microphone and audio
            </h2>
            <p className="mt-2 text-[0.85rem] text-slate-600">
              When you continue, the app may request microphone access if a mic device is present, but playback can still continue without one. Assistant playback uses the voice selected in streaming settings; choose speakers or headphones in your system sound settings. There is no separate pop-up to pick output devices in the page — that is normal browser behaviour.
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" className="ghost-btn" onClick={() => setStreamPreflightOpen(false)}>
                Cancel
              </button>
              <button type="button" className="ghost-btn-primary" onClick={() => void openStreamingCall()}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
      {open && masteringPanelOpen && (
        <div className="fixed right-3 top-24 z-[10001] w-[min(420px,calc(100vw-1.25rem))] rounded-2xl border border-white/60 bg-white/40 p-3 shadow-2xl backdrop-blur-xl">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <div className="text-[0.76rem] font-semibold uppercase tracking-[0.16em] text-slate-700">ElevenLabs Flash v2.5</div>
              <div className="text-sm font-semibold text-slate-900">Admin mastering panel</div>
            </div>
            <button type="button" className="ghost-btn px-2 py-1 text-[0.7rem]" onClick={() => setMasteringPanelOpen(false)}>
              Close
            </button>
          </div>

          <div className="ghost-scroll max-h-[74vh] space-y-3 overflow-y-auto pr-1 text-[0.72rem] text-slate-700">
            <div className="rounded-xl border border-slate-200 bg-white/70 p-3">
              <div className="font-semibold text-slate-900">Core voice settings</div>
              <label className="mt-2 block">
                Stability {activeMastering.voice_settings.stability.toFixed(2)}
                <input
                  className="mt-1 w-full"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={activeMastering.voice_settings.stability}
                  onChange={(event) =>
                    patchActiveAgentMastering((current) => ({
                      ...current,
                      voice_settings: { ...current.voice_settings, stability: Number(event.target.value) },
                    }))
                  }
                />
              </label>
              <label className="mt-2 block">
                Similarity boost {activeMastering.voice_settings.similarity_boost.toFixed(2)}
                <input
                  className="mt-1 w-full"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={activeMastering.voice_settings.similarity_boost}
                  onChange={(event) =>
                    patchActiveAgentMastering((current) => ({
                      ...current,
                      voice_settings: { ...current.voice_settings, similarity_boost: Number(event.target.value) },
                    }))
                  }
                />
              </label>
              <label className="mt-2 block">
                Style {activeMastering.voice_settings.style.toFixed(2)}
                <input
                  className="mt-1 w-full"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={activeMastering.voice_settings.style}
                  onChange={(event) =>
                    patchActiveAgentMastering((current) => ({
                      ...current,
                      voice_settings: { ...current.voice_settings, style: Number(event.target.value) },
                    }))
                  }
                />
              </label>
              <label className="mt-2 inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={activeMastering.voice_settings.use_speaker_boost}
                  onChange={() =>
                    patchActiveAgentMastering((current) => ({
                      ...current,
                      voice_settings: { ...current.voice_settings, use_speaker_boost: !current.voice_settings.use_speaker_boost },
                    }))
                  }
                />
                Use speaker boost
              </label>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/70 p-3">
              <div className="font-semibold text-slate-900">Delivery and deterministic controls</div>
              <label className="mt-2 block">
                Speed {activeMastering.voice_settings.speed.toFixed(2)}
                <input
                  className="mt-1 w-full"
                  type="range"
                  min={0.7}
                  max={1.2}
                  step={0.01}
                  value={activeMastering.voice_settings.speed}
                  onChange={(event) =>
                    patchActiveAgentMastering((current) => ({
                      ...current,
                      voice_settings: { ...current.voice_settings, speed: Number(event.target.value) },
                    }))
                  }
                />
              </label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="block">
                  Model ID
                  <input
                    className="ghost-input mt-1 w-full border-slate-200 bg-white py-1"
                    value={activeMastering.model_id}
                    onChange={(event) => patchActiveAgentMastering((current) => ({ ...current, model_id: event.target.value }))}
                  />
                </label>
                <label className="block">
                  Language code
                  <select
                    className="ghost-select mt-1 w-full py-1 text-[0.72rem]"
                    value={activeMastering.language_code}
                    onChange={(event) => patchActiveAgentMastering((current) => ({ ...current, language_code: event.target.value }))}
                  >
                    {["en", "es", "ja", "fr", "de", "it", "pt", "zh"].map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
                <label className="block">
                  Seed
                  <input
                    className="ghost-input mt-1 w-full border-slate-200 bg-white py-1"
                    type="number"
                    min={0}
                    value={activeMastering.seed ?? ""}
                    placeholder="auto"
                    onChange={(event) =>
                      patchActiveAgentMastering((current) => ({
                        ...current,
                        seed: event.target.value.trim() ? Number(event.target.value) : null,
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  className="ghost-btn self-end"
                  onClick={() => patchActiveAgentMastering((current) => ({ ...current, seed: randomSeed() }))}
                >
                  Randomize
                </button>
              </div>
              <label className="mt-2 block">
                Previous text
                <textarea
                  className="ghost-input mt-1 w-full border-slate-200 bg-white py-1"
                  rows={2}
                  value={activeMastering.previous_text}
                  onChange={(event) => patchActiveAgentMastering((current) => ({ ...current, previous_text: event.target.value }))}
                />
              </label>
              <label className="mt-2 block">
                Next text
                <textarea
                  className="ghost-input mt-1 w-full border-slate-200 bg-white py-1"
                  rows={2}
                  value={activeMastering.next_text}
                  onChange={(event) => patchActiveAgentMastering((current) => ({ ...current, next_text: event.target.value }))}
                />
              </label>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/70 p-3">
              <div className="font-semibold text-slate-900">Text pre-processing</div>
              <label className="mt-2 block">
                Apply text normalization
                <select
                  className="ghost-select mt-1 w-full py-1 text-[0.72rem]"
                  value={activeMastering.apply_text_normalization}
                  onChange={(event) =>
                    patchActiveAgentMastering((current) => ({
                      ...current,
                      apply_text_normalization: event.target.value as "auto" | "on" | "off",
                    }))
                  }
                >
                  <option value="auto">auto</option>
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
              </label>
              <div className="mt-2 space-y-2">
                <div className="text-[0.68rem] font-medium text-slate-800">Pronunciation dictionary locators</div>
                {activeMastering.pronunciation_dictionary_locators.map((locator, index) => (
                  <div key={`${index}-${locator.pronunciation_dictionary_id}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <input
                      className="ghost-input border-slate-200 bg-white py-1"
                      placeholder="dictionary id"
                      value={locator.pronunciation_dictionary_id}
                      onChange={(event) =>
                        patchActiveAgentMastering((current) => ({
                          ...current,
                          pronunciation_dictionary_locators: current.pronunciation_dictionary_locators.map((entry, idx) =>
                            idx === index ? { ...entry, pronunciation_dictionary_id: event.target.value } : entry,
                          ),
                        }))
                      }
                    />
                    <input
                      className="ghost-input border-slate-200 bg-white py-1"
                      placeholder="version id"
                      value={locator.version_id}
                      onChange={(event) =>
                        patchActiveAgentMastering((current) => ({
                          ...current,
                          pronunciation_dictionary_locators: current.pronunciation_dictionary_locators.map((entry, idx) =>
                            idx === index ? { ...entry, version_id: event.target.value } : entry,
                          ),
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="ghost-btn px-2 py-1"
                      onClick={() =>
                        patchActiveAgentMastering((current) => ({
                          ...current,
                          pronunciation_dictionary_locators: current.pronunciation_dictionary_locators.filter((_, idx) => idx !== index),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() =>
                    patchActiveAgentMastering((current) => ({
                      ...current,
                      pronunciation_dictionary_locators: [
                        ...current.pronunciation_dictionary_locators,
                        { pronunciation_dictionary_id: "", version_id: "" },
                      ],
                    }))
                  }
                >
                  Add locator
                </button>
              </div>
              <div className="mt-3 space-y-2">
                <div className="text-[0.68rem] font-medium text-slate-800">Custom replacements (Key → Value)</div>
                {activeMastering.pronunciation_replacements.map((entry, index) => (
                  <div key={`${index}-${entry.key}`} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <input
                      className="ghost-input border-slate-200 bg-white py-1"
                      placeholder="key word"
                      value={entry.key}
                      onChange={(event) =>
                        patchActiveAgentMastering((current) => ({
                          ...current,
                          pronunciation_replacements: current.pronunciation_replacements.map((item, idx) =>
                            idx === index ? { ...item, key: event.target.value } : item,
                          ),
                        }))
                      }
                    />
                    <input
                      className="ghost-input border-slate-200 bg-white py-1"
                      placeholder="phonetic replacement"
                      value={entry.value}
                      onChange={(event) =>
                        patchActiveAgentMastering((current) => ({
                          ...current,
                          pronunciation_replacements: current.pronunciation_replacements.map((item, idx) =>
                            idx === index ? { ...item, value: event.target.value } : item,
                          ),
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="ghost-btn px-2 py-1"
                      onClick={() =>
                        patchActiveAgentMastering((current) => ({
                          ...current,
                          pronunciation_replacements: current.pronunciation_replacements.filter((_, idx) => idx !== index),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() =>
                    patchActiveAgentMastering((current) => ({
                      ...current,
                      pronunciation_replacements: [...current.pronunciation_replacements, { key: "", value: "" }],
                    }))
                  }
                >
                  Add replacement
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/70 p-3">
              <div className="font-semibold text-slate-900">Save preset and quick recall</div>
              <div className="mt-2 flex gap-2">
                <input
                  className="ghost-input flex-1 border-slate-200 bg-white py-1"
                  placeholder='Narrator - Serious'
                  value={presetNameDraft}
                  onChange={(event) => setPresetNameDraft(event.target.value)}
                />
                <button type="button" className="ghost-btn-primary" onClick={saveMasteringPreset}>
                  Save preset
                </button>
              </div>
              <div className="mt-2 space-y-2">
                {streamDraft.presets.map((preset) => (
                  <div key={preset.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white/80 px-2 py-1.5">
                    <div className="truncate text-[0.68rem] font-medium text-slate-800">{preset.name}</div>
                    <div className="flex items-center gap-1">
                      <button type="button" className="ghost-btn px-2 py-1 text-[0.66rem]" onClick={() => applyMasteringPreset(preset.id)}>
                        Apply
                      </button>
                      <button type="button" className="ghost-btn px-2 py-1 text-[0.66rem]" onClick={() => removeMasteringPreset(preset.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
                {streamDraft.presets.length === 0 && <div className="text-[0.68rem] text-slate-500">No presets saved yet.</div>}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" className="ghost-btn-primary" disabled={!masteringDirty} onClick={saveStreamingSettings}>
                  Save now
                </button>
                <button type="button" className="ghost-btn" onClick={revertStreamingSettings}>
                  Quick revert to last saved
                </button>
                <span className={`text-[0.68rem] ${masteringDirty ? "text-amber-700" : "text-slate-500"}`}>
                  {masteringDirty ? "Unsaved mastering edits" : "Mastering settings synced"}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

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
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[0.64rem] font-semibold uppercase tracking-[0.16em] text-slate-700">
                  Workflow: {sessionWorkflowMode}
                </span>
                {documentFrame && (
                  <span className="text-[0.68rem] text-slate-600">
                    Document frame: <span className="font-semibold text-slate-900">{documentFrame.title}</span> ({documentFrame.fragments.length} approved)
                  </span>
                )}
                <span
                  className="text-[0.68rem] text-slate-600"
                  title="Approximate LLM tokens (cl100k) for this conversation, summed across turns."
                >
                  Tokens (est.):{" "}
                  <span className="font-mono tabular-nums font-medium text-slate-900">{llmTokenTotal.toLocaleString()}</span>
                </span>
                {lastLlmIo && (
                  <span className="text-[0.68rem] text-slate-600">
                    IN <span className="font-mono tabular-nums font-medium text-slate-900">{lastLlmIo.input_tokens.toLocaleString()}</span>{" "}
                    OUT <span className="font-mono tabular-nums font-medium text-slate-900">{lastLlmIo.output_tokens.toLocaleString()}</span>
                  </span>
                )}
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
                <div className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[0.68rem] text-slate-700">
                  <div><span className="font-medium text-slate-900">API:</span> {sessionApiMode}</div>
                  <div className="max-w-[180px] truncate font-mono text-[0.64rem]" title={sessionLlmModelId}>
                    <span className="font-medium font-sans text-slate-900">Model:</span> {sessionLlmModelId}
                  </div>
                </div>
                <button type="button" onClick={handleClose} className="ghost-icon-btn text-slate-500">
                  <CloseIcon size={14} />
                </button>
              </div>
            </div>
            {showTools && (
              <div className="ghost-scroll max-h-[180px] overflow-y-auto border-b border-black/5 bg-white/60 px-3 py-2 text-[0.72rem] text-slate-600">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                    <div className="font-semibold text-slate-900">Workflow launchers</div>
                    <div className="mt-1 text-[0.7rem] text-slate-500">
                      Start a new workflow-bound conversation without mutating the current thread.
                    </div>
                    <div className="mt-3 grid gap-2">
          {([
            ["standard", "New Standard Chat"],
            ["data_collector", "New Data Collector"],
            ["documenter", "New Documenter"],
            ["case_framing", "New Case Framing (hardened)"],
            ["evidence_retrieval", "New Evidence Retrieval (hardened)"],
            ["bp_mode", "New BP Mode (full build)"],
          ] as Array<[WorkflowMode, string]>).map(([workflowMode, label]) => (
                        <button
                          key={workflowMode}
                          type="button"
                          className="ghost-btn justify-between"
                          disabled={busy}
                          onClick={() => void startWorkflowConversation(workflowMode)}
                        >
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
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
                        <div className="font-semibold text-slate-900">Voice (streaming + chat TTS)</div>
                        <div className="mt-1 text-[0.7rem] text-slate-500">
                          Open streaming runs the voice WebSocket. Chat responses can speak via ElevenLabs sentence-by-sentence (starts soon after the first sentence while text is still streaming).
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <button
                          type="button"
                          className="ghost-btn-primary whitespace-nowrap"
                          disabled={
                            !voiceProviderStatus?.configured ||
                            !resolvedElevenLabsVoiceId ||
                            callState === "connecting" ||
                            callState === "listening" ||
                            callState === "thinking" ||
                            callState === "speaking"
                          }
                          onClick={() => void requestOpenStreamingPreflight()}
                        >
                          Open Streaming
                        </button>
                        <button
                          type="button"
                          className="ghost-btn whitespace-nowrap"
                          disabled={!activeAgentId}
                          onClick={() => setMasteringPanelOpen(true)}
                        >
                          Open Mastering Panel
                        </button>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={streamDraft.speakResponses}
                          disabled={!voiceProviderStatus?.configured}
                          onChange={() => setStreamDraft((d) => ({ ...d, speakResponses: !d.speakResponses }))}
                        />
                        Speak response (ElevenLabs)
                      </label>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => ttsRef.current?.stop()}
                        disabled={!voiceProviderStatus?.configured}
                      >
                        Stop speaking
                      </button>
                    </div>
                    <label className="mt-3 block text-[0.7rem] text-slate-500">
                      ElevenLabs voice (per agent, saved with settings below)
                      <select
                        className="ghost-select mt-1 w-full max-w-md py-1 text-[0.7rem]"
                        value={resolvedElevenLabsVoiceId}
                        disabled={!activeAgentId || !voiceProviderStatus?.configured || voiceProviderStatus.voices.length === 0}
                        onChange={(event) => {
                          if (!activeAgentId) return;
                          const v = event.target.value;
                          setStreamDraft((d) => ({ ...d, voiceByAgentId: { ...d.voiceByAgentId, [activeAgentId]: v } }));
                        }}
                      >
                        {voiceProviderStatus?.voices.length ? (
                          voiceProviderStatus.voices.map((voice) => (
                            <option key={voice.voice_id} value={voice.voice_id}>
                              {voice.name}
                            </option>
                          ))
                        ) : (
                          <option value="">ElevenLabs unavailable</option>
                        )}
                      </select>
                    </label>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="ghost-btn-primary"
                        disabled={!streamSettingsDirty}
                        onClick={saveStreamingSettings}
                      >
                        Save streaming settings
                      </button>
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={!streamSettingsDirty}
                        onClick={revertStreamingSettings}
                      >
                        Revert
                      </button>
                      {streamSettingsDirty ? (
                        <span className="text-[0.68rem] text-amber-700">Unsaved changes</span>
                      ) : (
                        <span className="text-[0.68rem] text-slate-500">Saved to this browser</span>
                      )}
                    </div>
                    <div className="mt-3 grid gap-1 text-[0.68rem] text-slate-600">
                      <div>
                        Mastering: model <span className="font-mono text-slate-900">{activeMastering.model_id}</span> · lang{" "}
                        <span className="font-mono text-slate-900">{activeMastering.language_code}</span> · speed{" "}
                        <span className="font-mono text-slate-900">{activeMastering.voice_settings.speed.toFixed(2)}</span> · seed{" "}
                        <span className="font-mono text-slate-900">{activeMastering.seed ?? "auto"}</span>
                      </div>
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={streamDraft.autoSaveMastering}
                          onChange={() => setStreamDraft((current) => ({ ...current, autoSaveMastering: !current.autoSaveMastering }))}
                        />
                        Auto-save mastering edits live
                      </label>
                    </div>
                    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.7rem] text-slate-600">
                      Browser STT: {voiceCapabilities.speechRecognition ? "available" : "unsupported"} · Mic:{" "}
                      {voiceCapabilities.mediaDevices ? "available" : "unsupported"} · ElevenLabs:{" "}
                      {voiceProviderStatus?.configured ? "configured" : "not configured"}
                      {voiceProviderStatus?.message ? <div className="mt-1">{voiceProviderStatus.message}</div> : null}
                    </div>
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

                  <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
                    <div className="font-semibold text-slate-900">Drop tables / context</div>
                    <div className="mt-1 text-[0.7rem] text-slate-500">
                      Paste tables or key facts here; they get appended into the document frame as <span className="font-semibold text-slate-700">note</span> fragments and will be used by the LLM.
                    </div>

                    <div className="mt-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[0.7rem] text-slate-500">Title</span>
                        <input
                          type="text"
                          className="ghost-input flex-1 border-slate-200 bg-white py-1"
                          value={frameContextTitle}
                          onChange={(event) => setFrameContextTitle(event.target.value)}
                          placeholder="e.g. Shopify costs mapping"
                          disabled={!activeConversationId || frameContextBusy}
                        />
                      </div>
                      <textarea
                        className="ghost-input w-full border-slate-200 bg-white py-1 text-slate-900 placeholder:text-slate-400"
                        value={frameContextContent}
                        onChange={(event) => setFrameContextContent(event.target.value)}
                        placeholder={"Paste markdown tables / CSV / bullet facts here..."}
                        rows={5}
                        disabled={!activeConversationId || frameContextBusy}
                      />
                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          className="ghost-btn-primary"
                          disabled={!activeConversationId || frameContextBusy || !frameContextContent.trim()}
                          onClick={() => void appendFrameContextNote()}
                          title={activeConversationId ? "Append as note into document frame" : "Start or select a conversation first"}
                        >
                          {frameContextBusy ? "Appending..." : "Append to document frame"}
                        </button>
                        {documentFrame && (
                          <span className="text-[0.68rem] text-slate-500" title="Approved document fragments count">
                            {documentFrame.fragments.length} approved
                          </span>
                        )}
                      </div>
                    </div>
                    {!activeConversationId && (
                      <div className="mt-2 text-[0.68rem] text-slate-500">
                        Start a conversation to use this panel.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {callState !== "idle" && (
              <div className="border-b border-black/5 bg-slate-950 px-4 py-3 text-white">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-ghost-orange">
                      Voice streaming simulator
                    </div>
                    <div className="mt-1 text-[0.78rem] text-slate-200">
                      State: <span className="font-semibold text-white">{callState}</span>
                      {resolvedElevenLabsVoiceId ? <span> · Voice: {resolvedElevenLabsVoiceId}</span> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="ghost-btn border-slate-600 bg-slate-900 text-white" onClick={() => ttsRef.current?.stop()}>
                      Stop speaking
                    </button>
                    <button type="button" className="ghost-btn-primary" onClick={stopCall}>
                      End call
                    </button>
                  </div>
                </div>
                {callError && <div className="mt-2 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-[0.74rem] text-red-100">{callError}</div>}
                {callTranscript && (
                  <div className="mt-2 max-h-24 overflow-y-auto rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[0.74rem] text-slate-200">
                    {callTranscript}
                  </div>
                )}
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
                  {entry.role === "assistant" && entry.routeDecision?.rationale_summary && (
                    <div className="mb-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[0.72rem] text-slate-700">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-[0.14em] text-slate-700">
                          Route: {entry.routeDecision.route_type}
                        </span>
                        {entry.routeDecision.document_intent && (
                          <span className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[0.6rem] font-semibold text-indigo-700">
                            Document intent
                          </span>
                        )}
                      </div>
                      <div className="text-slate-600">{entry.routeDecision.rationale_summary}</div>
                      {(entry.routeDecision.llm_execution ?? []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(entry.routeDecision.llm_execution ?? []).map((step, idx) => (
                            <span
                              key={`${step.stage}-${step.model_id}-${idx}`}
                              className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[0.62rem] font-medium text-slate-600"
                              title={`${step.connection_label ?? step.provider} • ${step.model_id} • in ${step.prompt_tokens} / out ${step.completion_tokens}`}
                            >
                              {step.stage}: {step.model_id} (in {step.prompt_tokens}, out {step.completion_tokens})
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {entry.role === "assistant" && entry.toolEvents && entry.toolEvents.length > 0 && (
                    <AgentToolTrace
                      toolEvents={entry.toolEvents}
                      routeType={entry.routeDecision?.route_type}
                      conversationMode={sessionConversationMode}
                    />
                  )}
                  {entry.role === "assistant" &&
                    !shouldShowMultiAgentToolTrace(
                      entry.routeDecision?.route_type,
                      sessionConversationMode,
                      entry.toolEvents?.length ?? 0,
                    ) &&
                    ((entry.toolEvents?.length ?? 0) > 0 || (entry.citations ?? []).some((cite: any) => cite?.source_type === "tool")) && (
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
                  {entry.llmIo && (
                    <div className="mt-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[0.65rem] text-slate-600">
                      <div className="flex flex-wrap gap-3">
                        <span>IN <span className="font-mono tabular-nums text-slate-800">{entry.llmIo.input_tokens.toLocaleString()}</span></span>
                        <span>OUT <span className="font-mono tabular-nums text-slate-800">{entry.llmIo.output_tokens.toLocaleString()}</span></span>
                        <span>TOTAL <span className="font-mono tabular-nums text-slate-800">{entry.llmIo.total_tokens.toLocaleString()}</span></span>
                      </div>
                      {(entry.llmIo.input_first_text || entry.llmIo.input_last_text) && (
                        <div className="mt-1 space-y-0.5">
                          <div><span className="font-semibold text-slate-700">Input first:</span> {entry.llmIo.input_first_text || "n/a"}</div>
                          <div><span className="font-semibold text-slate-700">Input last:</span> {entry.llmIo.input_last_text || "n/a"}</div>
                        </div>
                      )}
                    </div>
                  )}
                  {entry.citations && entry.citations.length > 0 && (
                    <div className="mt-2 text-[0.68rem] text-slate-500">{entry.citations.length} citation(s)</div>
                  )}
                  {entry.role === "assistant" && entry.text.trim() && sessionWorkflowMode !== "documenter" && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-200/70 pt-2">
                      {messageApprovalState[entry.id] && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[0.62rem] font-semibold ${
                            messageApprovalState[entry.id] === "approved"
                              ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border border-rose-200 bg-rose-50 text-rose-700"
                          }`}
                        >
                          {messageApprovalState[entry.id] === "approved" ? "Approved for document" : "Rejected"}
                        </span>
                      )}
                      <button
                        type="button"
                        className="ghost-btn py-1 text-[0.66rem]"
                        onClick={() => void approveMessageForDocument(entry.id)}
                      >
                        Approve for document
                      </button>
                      <button
                        type="button"
                        className="ghost-btn py-1 text-[0.66rem]"
                        onClick={() => rejectMessageForDocument(entry.id)}
                      >
                        Reject
                      </button>
                    </div>
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
                <button
                  type="button"
                  className={`ghost-btn px-3 ${isListening ? "border-ghost-orange text-ghost-orange" : ""}`}
                  disabled={!voiceCapabilities.speechRecognition || busy}
                  onClick={startListening}
                  title={voiceCapabilities.speechRecognition ? "Speak into the composer" : "Speech recognition is not supported in this browser"}
                >
                  {isListening ? "Listening" : "Mic"}
                </button>
                <input
                  type="text"
                  placeholder="Ask anything..."
                  className="ghost-input ghost-chat-composer-input flex-1 bg-slate-900 text-white placeholder:text-slate-400 caret-white border-slate-700"
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
              {voiceStatus && <div className="mt-2 text-[0.68rem] text-slate-500">{voiceStatus}</div>}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[0.68rem] text-slate-500">
                <span className="font-semibold uppercase tracking-[0.16em] text-slate-400">Workflow</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[0.7rem] font-semibold text-slate-700">
                  {sessionWorkflowMode}
                </span>
                <span className="font-semibold uppercase tracking-[0.16em] text-slate-400">Mode</span>
                <div className="flex flex-wrap items-center gap-1 rounded-full bg-slate-100 p-1">
                  {conversationModes.map((modeOption) => {
                    const active = sessionConversationMode === modeOption.id;
                    return (
                      <button
                        key={modeOption.id}
                        type="button"
                        onClick={() => setSessionConversationMode(modeOption.id)}
                        disabled={busy}
                        className={`rounded-full px-3 py-1 text-[0.7rem] font-semibold transition-colors ${
                          active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-900"
                        } ${busy ? "cursor-not-allowed opacity-70" : ""}`}
                        title={modeOption.hint}
                      >
                        {modeOption.label}
                      </button>
                    );
                  })}
                </div>
                <span>{conversationModes.find((modeOption) => modeOption.id === sessionConversationMode)?.hint}</span>
                <button
                  type="button"
                  onClick={() =>
                    setSessionDocxMode((current) => ({
                      ...current,
                      enabled: !current.enabled,
                    }))
                  }
                  className={`ml-auto rounded-full border px-3 py-1 text-[0.68rem] font-semibold transition-colors ${
                    sessionDocxMode.enabled
                      ? "border-ghost-orange bg-ghost-orange/10 text-ghost-orange"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  Apryse Docs {sessionDocxMode.enabled ? "On" : "Off"}
                </button>
              </div>
              {sessionDocxMode.enabled && (
                <div className="mt-3 h-[320px]">
                  <ApryseDocumentPanel
                    docxMode={{
                      enabled: sessionDocxMode.enabled,
                      templateId: sessionDocxMode.template_id,
                      operation: sessionDocxMode.operation,
                      bindingOverrides: sessionDocxMode.binding_overrides,
                    }}
                    onDocxModeChange={(next) =>
                      setSessionDocxMode({
                        enabled: next.enabled,
                        template_id: next.templateId,
                        operation: next.operation,
                        binding_overrides: next.bindingOverrides,
                      })
                    }
                    artifacts={docxArtifacts}
                    diagnostics={docxDiagnostics}
                  />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
