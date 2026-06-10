import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAgents,
  saveAgent,
  streamChat,
  type AgentProfile,
} from "../api";
import HubTigerBookingFlowRunner from "./HubTigerBookingFlowRunner";
import {
  BOOKING_WORKFLOW_STEPS,
  MAGIC_MIKE_OPENING_LINE,
  TWO_TOOL_BOOKING_STEPS,
} from "../lib/bookingWorkflowSimulation";
import { CloseIcon, SettingsIcon } from "./ReferenceIcons";

type PanelView = "inline" | "widget";
type PanelTab = "chat" | "prompt" | "workflow";

function formatChatErrorMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { detail?: Array<{ msg?: string; loc?: (string | number)[] }> };
    if (Array.isArray(parsed.detail) && parsed.detail.length > 0) {
      return parsed.detail
        .map((item) => {
          const loc = Array.isArray(item.loc) ? item.loc.filter((p) => p !== "body").join(".") : "";
          const prefix = loc ? `${loc}: ` : "";
          return `${prefix}${item.msg ?? "Validation error"}`;
        })
        .join(" ");
    }
  } catch {
    /* not JSON */
  }
  return raw.trim() || "Chat request failed.";
}

type ChatLine = {
  id: string;
  role: "agent" | "user" | "system";
  text: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

function PhoneIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.7 3.5.7.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.3 2.4.7 3.5.2.3.1.7-.2 1L6.6 10.8z" />
    </svg>
  );
}

function ExpandIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}

export default function AgentSimulationPanel({ open, onClose }: Props) {
  const [view, setView] = useState<PanelView>("inline");
  const [tab, setTab] = useState<PanelTab>("chat");
  const [expanded, setExpanded] = useState(false);
  const [mockTools, setMockTools] = useState(true);
  const [lines, setLines] = useState<ChatLine[]>([{ id: "open", role: "agent", text: MAGIC_MIKE_OPENING_LINE }]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [bookingFlowMode, setBookingFlowMode] = useState<"two-tool" | "staged">("two-tool");
  const [agentBaselinePrompt, setAgentBaselinePrompt] = useState("");
  const [promptSaveBusy, setPromptSaveBusy] = useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    void fetchAgents()
      .then((agents) => {
        const mike =
          agents.find((a) => /magic\s*mike/i.test(a.name)) ??
          agents.find((a) => /mike/i.test(a.name)) ??
          agents[0] ??
          null;
        setAgent(mike);
      })
      .catch(() => setAgent(null));
  }, [open]);

  useEffect(() => {
    if (!agent) return;
    const baseline = String(agent.runtime_profile?.guardrails_config?.system_prompt ?? "").trim();
    setAgentBaselinePrompt(baseline);
    setSystemPromptDraft((current) => (promptDirty ? current : baseline));
  }, [agent?.id, open, promptDirty, agent]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, open, tab]);

  const appendLine = useCallback((role: ChatLine["role"], text: string) => {
    setLines((prev) => [...prev, { id: `${Date.now()}-${prev.length}`, role, text }]);
  }, []);

  async function sendChatMessage() {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    appendLine("user", text);
    if (!mockTools) {
      appendLine("system", "Mock tools off — wire ElevenLabs agent or enable Mock tools to run HubTiger steps.");
      return;
    }
    if (!agent) {
      appendLine("system", "No Magic Mike agent profile found. Create the agent in Agent config first.");
      return;
    }
    setSending(true);
    let agentText = "";
    try {
      const usePromptOverride =
        promptDirty && systemPromptDraft.trim() !== agentBaselinePrompt.trim();
      await streamChat({
        message: text,
        agentId: agent.id,
        conversationId,
        conversationMode: "quick",
        systemPromptOverride: usePromptOverride ? systemPromptDraft : undefined,
        onStart: (payload) => {
          if (payload.conversation_id) setConversationId(payload.conversation_id);
        },
        onDelta: (delta) => {
          agentText += delta;
        },
        onDone: () => {
          appendLine("agent", agentText.trim() || "…");
        },
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Chat request failed.";
      appendLine("system", formatChatErrorMessage(raw));
    } finally {
      setSending(false);
    }
  }

  async function savePromptToProfile() {
    if (!agent) return;
    setPromptSaveBusy(true);
    try {
      await saveAgent({
        id: agent.id,
        name: agent.name,
        first_message: agent.first_message,
        language: agent.language,
        voice_id: agent.voice_id,
        runtime_profile_id: agent.runtime_profile_id,
        runtime_profile: {
          ...agent.runtime_profile,
          guardrails_config: {
            ...agent.runtime_profile.guardrails_config,
            system_prompt: systemPromptDraft.trim(),
          },
        },
        agent_role: agent.agent_role,
        parent_agent_id: agent.parent_agent_id,
        position: agent.position,
        is_default: agent.is_default,
        enabled: agent.enabled,
      });
      setAgentBaselinePrompt(systemPromptDraft.trim());
      setPromptDirty(false);
      appendLine("system", "System prompt saved to Agent Config.");
    } catch {
      appendLine("system", "Could not save prompt to Agent Config.");
    } finally {
      setPromptSaveBusy(false);
    }
  }

  const panelWidth = expanded ? "min(720px, 92vw)" : "min(420px, 100vw)";

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            aria-label="Close simulation backdrop"
            className="fixed inset-0 z-[9997] bg-slate-900/20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            aria-label="Agent simulation"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            className="agent-simulation-panel fixed right-0 top-0 z-[9998] flex h-full flex-col border-l border-slate-200 bg-white shadow-2xl"
            style={{ width: panelWidth }}
          >
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
              <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-[0.72rem] font-semibold">
                <button
                  type="button"
                  onClick={() => setView("inline")}
                  className={`rounded-md px-3 py-1 ${view === "inline" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
                >
                  Inline
                </button>
                <button
                  type="button"
                  onClick={() => setView("widget")}
                  className={`rounded-md px-3 py-1 ${view === "widget" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
                >
                  Widget
                </button>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[0.68rem] font-medium text-slate-600">
                  <span>Mock tools</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={mockTools}
                    onClick={() => setMockTools((v) => !v)}
                    className={`relative h-5 w-9 rounded-full transition ${mockTools ? "bg-slate-900" : "bg-slate-300"}`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${mockTools ? "left-4" : "left-0.5"}`}
                    />
                  </button>
                  <span className="text-slate-400">{mockTools ? "On" : "Off"}</span>
                </label>
                <button type="button" className="ghost-icon-btn text-slate-500" title={expanded ? "Narrow panel" : "Expand panel"} onClick={() => setExpanded((v) => !v)}>
                  <ExpandIcon />
                </button>
                <button type="button" className="ghost-icon-btn text-slate-600" onClick={onClose} title="Close">
                  <CloseIcon size={16} />
                </button>
              </div>
            </header>

            {view === "inline" && (
              <>
                <div className="flex shrink-0 border-b border-slate-100 px-2 py-1.5 gap-0.5">
                  <button
                    type="button"
                    onClick={() => setTab("chat")}
                    className={`flex-1 rounded-md py-1 text-[0.68rem] font-semibold ${tab === "chat" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab("prompt")}
                    className={`flex-1 rounded-md py-1 text-[0.68rem] font-semibold ${tab === "prompt" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                  >
                    System prompt
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab("workflow")}
                    className={`flex-1 rounded-md py-1 text-[0.68rem] font-semibold ${tab === "workflow" ? "bg-slate-900 text-white" : "text-slate-600"}`}
                  >
                    Booking
                  </button>
                </div>

                {tab === "chat" ? (
                  <>
                    <div ref={scrollRef} className="agent-simulation-chat min-h-0 flex-1 overflow-y-auto px-4 py-4">
                      <p className="mb-4 text-center text-[0.68rem] text-slate-400">Chat started</p>
                      {lines.map((line) => (
                        <div key={line.id} className={`mb-3 flex gap-2 ${line.role === "user" ? "justify-end" : ""}`}>
                          {line.role === "agent" && (
                            <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500" aria-hidden />
                          )}
                          <div
                            className={`max-w-[90%] text-[0.82rem] leading-relaxed ${
                              line.role === "user"
                                ? "rounded-2xl bg-slate-100 px-3 py-2 text-slate-900"
                                : line.role === "system"
                                  ? "rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900"
                                  : "text-slate-800"
                            }`}
                          >
                            {line.text}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="shrink-0 border-t border-slate-200 p-3">
                      <div className="rounded-2xl border border-slate-900/80 bg-white px-3 py-2 shadow-sm">
                        <textarea
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              void sendChatMessage();
                            }
                          }}
                          rows={2}
                          placeholder="Send a message"
                          className="w-full resize-none border-0 bg-transparent text-[0.82rem] outline-none placeholder:text-slate-400"
                          disabled={sending}
                        />
                        <div className="mt-1 flex items-center justify-between">
                          <div className="flex items-center gap-2 text-slate-400">
                            <SettingsIcon size={14} />
                            <span className="text-[0.65rem]">{agent?.name ?? "Loading agent…"}</span>
                          </div>
                          <button
                            type="button"
                            disabled={sending || !draft.trim()}
                            onClick={() => void sendChatMessage()}
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-white disabled:opacity-40"
                            title="Send"
                          >
                            <span className="ml-0.5 text-[0.65rem]">▶</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </>
                ) : tab === "prompt" ? (
                  <div className="ghost-scroll flex min-h-0 flex-1 flex-col p-3 text-[0.76rem]">
                    <p className="text-[0.64rem] font-bold uppercase tracking-[0.18em] text-slate-400">System prompt</p>
                    <p className="mt-1 text-slate-600">
                      Overrides the agent profile prompt for this simulator session only. Does not save to Agent config.
                    </p>
                    <p className="mt-2 text-[0.68rem] text-slate-500">
                      Agent: <span className="font-semibold text-slate-700">{agent?.name ?? "—"}</span>
                      {promptDirty && <span className="ml-2 text-orange-600">(modified)</span>}
                    </p>
                    <textarea
                      value={systemPromptDraft}
                      onChange={(e) => {
                        setSystemPromptDraft(e.target.value);
                        setPromptDirty(true);
                      }}
                      rows={expanded ? 22 : 14}
                      className="glass-input mt-2 min-h-0 flex-1 w-full resize-y rounded-md px-2 py-2 font-mono text-[0.7rem] leading-relaxed"
                      placeholder="Load an agent to edit its system prompt…"
                      disabled={!agent}
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="glass-button rounded-md px-3 py-1.5 text-[0.72rem] font-semibold"
                        disabled={!agent}
                        onClick={() => {
                          setSystemPromptDraft(agentBaselinePrompt);
                          setPromptDirty(false);
                        }}
                      >
                        Reset to agent default
                      </button>
                      <button
                        type="button"
                        className="glass-button rounded-md px-3 py-1.5 text-[0.72rem]"
                        disabled={promptSaveBusy || !agent}
                        onClick={() => void savePromptToProfile()}
                      >
                        {promptSaveBusy ? "Saving…" : "Save to Agent Config"}
                      </button>
                      <button
                        type="button"
                        className="glass-button rounded-md px-3 py-1.5 text-[0.72rem]"
                        onClick={() => setTab("chat")}
                      >
                        Back to chat
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="ghost-scroll min-h-0 flex-1 overflow-y-auto p-3 text-[0.76rem]">
                    <div className="mb-2 flex gap-1">
                      <button
                        type="button"
                        onClick={() => setBookingFlowMode("two-tool")}
                        className={`flex-1 rounded-md py-1 text-[0.68rem] font-semibold ${
                          bookingFlowMode === "two-tool" ? "bg-orange-600 text-white" : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        Two-tool
                      </button>
                      <button
                        type="button"
                        onClick={() => setBookingFlowMode("staged")}
                        className={`flex-1 rounded-md py-1 text-[0.68rem] font-semibold ${
                          bookingFlowMode === "staged" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        Staged
                      </button>
                    </div>
                    {!mockTools && <p className="mb-2 text-slate-500">Turn Mock tools on to call HubTiger live.</p>}
                    <HubTigerBookingFlowRunner
                      steps={bookingFlowMode === "two-tool" ? TWO_TOOL_BOOKING_STEPS : BOOKING_WORKFLOW_STEPS}
                      onVoiceLine={(text) => appendLine("agent", text)}
                    />
                  </div>
                )}
              </>
            )}

            {view === "widget" && (
              <div className="agent-simulation-widget-bg relative flex min-h-0 flex-1 flex-col">
                <div className="relative flex flex-1 flex-col items-center justify-center p-6">
                  <div className="agent-simulation-orb" aria-hidden />
                  <button
                    type="button"
                    className="relative z-10 -mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-slate-900 text-white shadow-lg"
                    title="Start voice session (ElevenLabs ConvAI in production)"
                    onClick={() => {
                      appendLine("system", "Voice calls use your ElevenLabs ConvAI widget in production. Switch to Inline for text + workflow steps.");
                      setView("inline");
                      setTab("chat");
                    }}
                  >
                    <PhoneIcon size={20} />
                  </button>
                </div>
                <div className="relative z-10 shrink-0 border-t border-slate-200/60 p-3">
                  <div className="rounded-2xl border border-slate-900/80 bg-white px-3 py-2 shadow-sm">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          setView("inline");
                          void sendChatMessage();
                        }
                      }}
                      rows={2}
                      placeholder={lines.length <= 1 ? "Send a message to start a chat" : "Send a message"}
                      className="w-full resize-none border-0 bg-transparent text-[0.82rem] outline-none placeholder:text-slate-400"
                      disabled={sending}
                    />
                    <div className="mt-1 flex items-center justify-between">
                      <div className="flex items-center gap-2 text-slate-400">
                        <SettingsIcon size={14} />
                        <span className="text-slate-500" title="Microphone (ElevenLabs voice)">
                          <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden>
                            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-4.08c3.39-.49 6-3.39 6-6.92h-2z" />
                          </svg>
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={sending || !draft.trim()}
                        onClick={() => {
                          setView("inline");
                          void sendChatMessage();
                        }}
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-white disabled:opacity-40"
                        title="Send"
                      >
                        <span className="ml-0.5 text-[0.65rem]">▶</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
