import { useRef, useEffect } from "react";
import { PlusIcon, SendIcon } from "../../components/ReferenceIcons";
import type { ChatDocxMode, ConversationMode, WorkflowMode } from "../../api";

const BUSINESS_STRUCTURE_TEMPLATE = `Business structure:
- Legal entities and operating brands:
- Reporting entities (branches/stores/sites):
- Channel-only scopes (not legal entities):
- Group roll-up rules:
- Accounting/scope rules (tax, refunds, intercompany, journal constraints):`;

type Props = {
  message: string;
  setMessage: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  activeConversationId: string | null;
  activeAgentId: string | null;
  uploadBusy: boolean;
  onUploadClick: () => void;
  useApprovedWeb: boolean;
  onToggleWeb: () => void;
  approvedWebConfigured: boolean;
  conversationMode: ConversationMode;
  onConversationModeChange: (mode: ConversationMode) => void;
  workflowMode: WorkflowMode;
  docxMode: ChatDocxMode;
  onDocxModeChange: (next: ChatDocxMode) => void;
};

export default function ChatComposer({
  message,
  setMessage,
  onSend,
  busy,
  activeConversationId,
  activeAgentId,
  uploadBusy,
  onUploadClick,
  useApprovedWeb,
  onToggleWeb,
  approvedWebConfigured,
  conversationMode,
  onConversationModeChange,
  workflowMode,
  docxMode,
  onDocxModeChange,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [message]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const handleInsertBusinessStructureTemplate = () => {
    const trimmed = message.trim();
    const nextValue = trimmed ? `${trimmed}\n\n${BUSINESS_STRUCTURE_TEMPLATE}` : BUSINESS_STRUCTURE_TEMPLATE;
    setMessage(nextValue);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const uploadDisabled = !activeConversationId || !activeAgentId || uploadBusy;
  const sendDisabled = !message.trim() || busy || !activeAgentId;
  const conversationModes: Array<{
    id: ConversationMode;
    label: string;
    hint: string;
  }> = [
    { id: "quick", label: "Quick", hint: "Fast first pass" },
    { id: "board", label: "Board", hint: "Full executive answer" },
    { id: "working_session", label: "Working Session", hint: "Coach through the data" },
  ];

  return (
    <div className="relative mx-auto w-full max-w-[1200px] px-4 pb-5 pt-2">
      <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-2.5 shadow-sm transition-shadow focus-within:border-ghost-orange focus-within:ring-4 focus-within:ring-ghost-orange/10">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message GHOST_CORE..."
          className="w-full resize-none border-none bg-transparent py-1 text-[0.92rem] leading-relaxed text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0 max-h-[180px] overflow-y-auto"
          rows={1}
          disabled={busy}
        />
        
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-1 pt-2">
          <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Workflow</span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-[0.72rem] font-semibold text-slate-700">
            {workflowMode}
          </span>
          <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-slate-400">Mode</span>
          <div className="flex flex-wrap items-center gap-1 rounded-full bg-slate-100 p-1">
            {conversationModes.map((modeOption) => {
              const active = conversationMode === modeOption.id;
              return (
                <button
                  key={modeOption.id}
                  type="button"
                  onClick={() => onConversationModeChange(modeOption.id)}
                  disabled={busy}
                  className={`rounded-full px-3 py-1.5 text-[0.72rem] font-semibold transition-colors ${
                    active
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-900"
                  } ${busy ? "cursor-not-allowed opacity-70" : ""}`}
                  title={modeOption.hint}
                >
                  {modeOption.label}
                </button>
              );
            })}
          </div>
          <span className="text-[0.72rem] text-slate-500">
            {conversationModes.find((modeOption) => modeOption.id === conversationMode)?.hint}
          </span>
          <button
            type="button"
            onClick={() =>
              onDocxModeChange({
                ...docxMode,
                enabled: !docxMode.enabled,
              })
            }
            disabled={busy}
            className={`ml-auto rounded-full border px-3 py-1.5 text-[0.72rem] font-semibold transition-colors ${
              docxMode.enabled
                ? "border-ghost-orange bg-ghost-orange/10 text-ghost-orange"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            } ${busy ? "cursor-not-allowed opacity-70" : ""}`}
          >
            Apryse Docs {docxMode.enabled ? "On" : "Off"}
          </button>
          {docxMode.enabled && (
            <>
              <select
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[0.72rem] text-slate-700"
                value={docxMode.operation ?? "preview"}
                onChange={(event) =>
                  onDocxModeChange({
                    ...docxMode,
                    operation: event.target.value as "preview" | "finalize",
                  })
                }
                disabled={busy}
              >
                <option value="preview">Preview</option>
                <option value="finalize">Finalize</option>
              </select>
              <input
                className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[0.72rem] text-slate-700"
                value={docxMode.template_id ?? ""}
                onChange={(event) =>
                  onDocxModeChange({
                    ...docxMode,
                    template_id: event.target.value,
                  })
                }
                placeholder="Template ID"
                disabled={busy}
              />
            </>
          )}
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onUploadClick}
              disabled={uploadDisabled}
              className={`flex items-center gap-1.5 rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                uploadDisabled 
                  ? "bg-slate-50 text-slate-400 cursor-not-allowed" 
                  : "bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              }`}
            >
              <PlusIcon size={14} />
              <span>DOCS</span>
            </button>
            
            <button
              type="button"
              onClick={onToggleWeb}
              disabled={!approvedWebConfigured}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                !approvedWebConfigured 
                  ? "border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed" 
                  : useApprovedWeb 
                    ? "border-ghost-orange bg-ghost-orange/10 text-ghost-orange"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              }`}
              title={
                !approvedWebConfigured 
                  ? "Web search is not configured for this agent" 
                  : useApprovedWeb ? "Disable web search" : "Enable web search"
              }
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
              </svg>
              <span>TOOLS</span>
            </button>
            
            <button
              type="button"
              disabled={true}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400 cursor-not-allowed"
              title="Voice synthesis coming soon"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="23"></line>
                <line x1="8" y1="23" x2="16" y2="23"></line>
              </svg>
              <span>VOICE</span>
            </button>
            <button
              type="button"
              onClick={handleInsertBusinessStructureTemplate}
              disabled={busy}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                busy
                  ? "border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              }`}
              title="Insert business structure template"
            >
              <span>STRUCTURE</span>
            </button>
          </div>
          
          <button
            type="button"
            onClick={onSend}
            disabled={sendDisabled}
            className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
              sendDisabled
                ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                : "bg-slate-900 text-white hover:bg-ghost-orange shadow-sm"
            }`}
          >
            <SendIcon size={16} />
          </button>
        </div>
      </div>
      
    </div>
  );
}
