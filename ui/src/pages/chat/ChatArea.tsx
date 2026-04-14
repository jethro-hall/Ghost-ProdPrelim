import { useState } from "react";
import MessageList from "./MessageList";
import ChatComposer from "./ChatComposer";

type Props = {
  chatEngine: any; // Type from useChatEngine
};

export default function ChatArea({ chatEngine }: Props) {
  const [message, setMessage] = useState("");

  const {
    log,
    busy,
    activeAgent,
    activeConversationId,
    activeAgentId,
    uploadBusy,
    useApprovedWeb,
    setUseApprovedWeb,
    approvedWebConfigured,
    sendMessage,
    handleStageUpload,
    llmTokenTotal,
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
      </div>
      <MessageList 
        log={log} 
        busy={busy} 
        firstMessage={activeAgent?.first_message ?? "Hello! I'm GhostChat. How can I help you today?"} 
      />
      
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
        />
      </div>
    </div>
  );
}
