import { useState } from "react";
import type { DocxArtifact, DocxDiagnostic } from "../../api";
import MessageList from "./MessageList";
import ChatComposer from "./ChatComposer";
import ApryseDocumentPanel from "../../components/chat/ApryseDocumentPanel";
import BpRunFeedPanel from "../../components/chat/BpRunFeedPanel";

type Props = {
  chatEngine: any; // Type from useChatEngine
};

export default function ChatArea({ chatEngine }: Props) {
  const [message, setMessage] = useState("");
  const [bpPanelOpen, setBpPanelOpen] = useState(false);

  const {
    log,
    busy,
    activeAgent,
    activeConversationId,
    activeAgentId,
    uploadBusy,
    documentFrame,
    documentDecisionByMessage,
    useApprovedWeb,
    setUseApprovedWeb,
    approvedWebConfigured,
    sessionConversationMode,
    setSessionConversationMode,
    sessionWorkflowMode,
    sessionDocxMode,
    setSessionDocxMode,
    docxArtifacts,
    docxDiagnostics,
    sendMessage,
    approveMessageForDocument,
    rejectMessageForDocument,
    handleStageUpload,
    llmTokenTotal,
    lastLlmIo,
    bpRunFeed,
  } = chatEngine;

  const handleSend = async () => {
    const nextMessage = message.trim();
    if (!nextMessage) {
      return;
    }
    setMessage("");
    const sent = await sendMessage(nextMessage);
    if (!sent) {
      setMessage(nextMessage);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col relative bg-slate-50/50">
      <div
        className="shrink-0 border-b border-slate-100 bg-white/90 px-4 py-1 text-[0.68rem] text-slate-600"
        title="Approximate LLM tokens (cl100k) summed for this conversation."
      >
        <span className="font-medium text-slate-800">LLM tokens (est.)</span>{" "}
        <span className="font-mono tabular-nums text-slate-900">{llmTokenTotal.toLocaleString()}</span>
        {lastLlmIo && (
          <span className="ml-3 inline-flex gap-3">
            <span>IN <span className="font-mono tabular-nums text-slate-900">{lastLlmIo.input_tokens.toLocaleString()}</span></span>
            <span>OUT <span className="font-mono tabular-nums text-slate-900">{lastLlmIo.output_tokens.toLocaleString()}</span></span>
            <span>TOTAL <span className="font-mono tabular-nums text-slate-900">{lastLlmIo.total_tokens.toLocaleString()}</span></span>
          </span>
        )}
      </div>
      {lastLlmIo && (lastLlmIo.input_first_text || lastLlmIo.input_last_text) && (
        <div className="shrink-0 border-b border-slate-100 bg-slate-50/70 px-4 py-1 text-[0.66rem] text-slate-600">
          <div><span className="font-semibold text-slate-800">Input first:</span> {lastLlmIo.input_first_text || "n/a"}</div>
          <div><span className="font-semibold text-slate-800">Input last:</span> {lastLlmIo.input_last_text || "n/a"}</div>
        </div>
      )}
      <div className="shrink-0 border-b border-slate-100 bg-slate-50/80 px-4 py-2 text-[0.72rem] text-slate-600">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            <span className="font-semibold text-slate-800">Workflow</span> {sessionWorkflowMode}
          </span>
          {documentFrame && (
            <span>
              <span className="font-semibold text-slate-800">Document frame</span> {documentFrame.title} ({documentFrame.fragments.length} approved)
            </span>
          )}
        </div>
      </div>
      <div
        className={`grid min-h-0 flex-1 gap-3 p-3 ${
          sessionWorkflowMode === "bp_mode"
            ? (bpPanelOpen ? "lg:grid-cols-[minmax(0,1fr)_360px_420px]" : "lg:grid-cols-[minmax(0,1fr)_96px_420px]")
            : "lg:grid-cols-[minmax(0,1fr)_420px]"
        }`}
      >
        <div className="min-h-0">
          <MessageList 
            log={log} 
            busy={busy} 
            firstMessage={activeAgent?.first_message ?? "Hello! I'm GhostChat. How can I help you today?"} 
            workflowMode={sessionWorkflowMode}
            conversationMode={sessionConversationMode}
            docxModeEnabled={Boolean(sessionDocxMode.enabled)}
            onApproveMessage={approveMessageForDocument}
            onRejectMessage={rejectMessageForDocument}
            documentDecisionByMessage={documentDecisionByMessage}
          />
        </div>
        {sessionWorkflowMode === "bp_mode" && (
          <div className="min-h-0">
            <BpRunFeedPanel
              open={bpPanelOpen}
              onToggle={() => setBpPanelOpen((current) => !current)}
              events={bpRunFeed}
              tokenTotal={llmTokenTotal}
              busy={busy}
            />
          </div>
        )}
        <div className="min-h-0">
          <ApryseDocumentPanel
            docxMode={{
              enabled: Boolean(sessionDocxMode.enabled),
              templateId: sessionDocxMode.template_id ?? "",
              operation: sessionDocxMode.operation ?? "preview",
              bindingOverrides: sessionDocxMode.binding_overrides ?? {},
            }}
            onDocxModeChange={(next) =>
              setSessionDocxMode({
                enabled: next.enabled,
                template_id: next.templateId,
                operation: next.operation,
                binding_overrides: next.bindingOverrides,
              })
            }
            artifacts={docxArtifacts.map((artifact: DocxArtifact) => ({
              kind: artifact.kind,
              uri: artifact.uri,
              label: artifact.label ?? null,
            }))}
            diagnostics={docxDiagnostics.map((item: DocxDiagnostic) => ({
              code: item.code,
              message: item.message,
              field: item.field ?? null,
            }))}
          />
        </div>
      </div>
      
      <div className="sticky bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-white via-white to-transparent pt-6">
        <ChatComposer
          message={message}
          setMessage={setMessage}
          onSend={handleSend}
          busy={busy}
          activeConversationId={activeConversationId}
          activeAgentId={activeAgentId}
          uploadBusy={uploadBusy}
          onUploadClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.onchange = (e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (file) handleStageUpload(file);
            };
            input.click();
          }}
          useApprovedWeb={useApprovedWeb}
          onToggleWeb={() => setUseApprovedWeb(!useApprovedWeb)}
          approvedWebConfigured={approvedWebConfigured}
          conversationMode={sessionConversationMode}
          onConversationModeChange={setSessionConversationMode}
          workflowMode={sessionWorkflowMode}
          docxMode={sessionDocxMode}
          onDocxModeChange={setSessionDocxMode}
        />
      </div>
    </div>
  );
}
