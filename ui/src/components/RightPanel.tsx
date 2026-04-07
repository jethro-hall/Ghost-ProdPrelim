import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { ChatApiMode, Connection, ConnectionTestResult } from "../api";
import { testConnection } from "../api";
import { CloseIcon } from "./ReferenceIcons";

type Props = {
  open: boolean;
  onClose: () => void;
  connections: Connection[];
  apiMode: ChatApiMode;
  onApiModeChange: (mode: ChatApiMode) => void;
  onSave: (connection: {
    provider: string;
    label?: string;
    api_key?: string;
    base_url?: string;
    chat_model?: string;
    embedding_model?: string;
    enabled?: boolean;
  }) => Promise<void>;
};

export default function RightPanel({
  open,
  onClose,
  connections,
  apiMode,
  onApiModeChange,
  onSave,
}: Props) {
  const openai = connections.find((connection) => connection.provider === "openai");
  const [label, setLabel] = useState("OpenAI");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [chatModel, setChatModel] = useState("openai/gpt-5.4");
  const [embeddingModel, setEmbeddingModel] = useState("openai/text-embedding-3-small");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLabel(openai?.label ?? "OpenAI");
    setApiKey("");
    setBaseUrl(openai?.base_url ?? "https://api.openai.com/v1");
    setChatModel(openai?.chat_model ?? "openai/gpt-5.4");
    setEmbeddingModel(openai?.embedding_model ?? "openai/text-embedding-3-small");
    setTestResult(null);
    setTestError(null);
  }, [open, openai]);

  async function handleTest() {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await testConnection({
        provider: "openai",
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        chat_model: chatModel || undefined,
        api_mode: apiMode,
      });
      setTestResult(result);
    } catch (error) {
      setTestError(String(error));
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({
        provider: "openai",
        label: label || "OpenAI",
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        chat_model: chatModel || undefined,
        embedding_model: embeddingModel || undefined,
        enabled: true,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            aria-label="Close panel"
            className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="glass-popup ghost-scroll fixed right-0 top-0 z-50 flex h-full w-full max-w-[360px] flex-col gap-4 overflow-y-auto border-l border-white/60 p-5"
            initial={{ x: "100%", opacity: 0.8 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "100%", opacity: 0.8 }}
            transition={{ type: "spring", stiffness: 280, damping: 30 }}
          >
            <div className="flex items-center justify-between border-b border-black/5 pb-2">
              <div>
                <h2 className="text-[1.05rem] font-semibold text-slate-900">Connections</h2>
                <p className="text-[0.75rem] text-slate-500">Save credentials, choose the chat API, and test live.</p>
              </div>
              <button type="button" aria-label="Close connections panel" className="ghost-icon-btn text-slate-500" onClick={onClose}>
                <CloseIcon size={14} />
              </button>
            </div>

            <div className="flex flex-col gap-3 text-[0.8rem]">
              <label className="font-medium text-slate-600">Label</label>
              <input className="ghost-input" value={label} onChange={(event) => setLabel(event.target.value)} />

              <label className="font-medium text-slate-600">API key</label>
              <input
                type="password"
                className="ghost-input"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={openai?.has_api_key ? "leave blank to keep saved key" : "sk-..."}
              />

              <label className="font-medium text-slate-600">Base URL</label>
              <input className="ghost-input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />

              <label className="font-medium text-slate-600">Chat model</label>
              <input className="ghost-input" value={chatModel} onChange={(event) => setChatModel(event.target.value)} />

              <label className="font-medium text-slate-600">Embedding model</label>
              <input className="ghost-input" value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} />

              <label className="font-medium text-slate-600">Chat API mode</label>
              <select className="ghost-select" value={apiMode} onChange={(event) => onApiModeChange(event.target.value as ChatApiMode)}>
                <option value="responses">Responses API</option>
                <option value="chat_completions">Chat Completions API</option>
              </select>

              <div className="mt-1 flex items-center gap-2">
                <button type="button" className="ghost-btn" disabled={testing || saving} onClick={() => void handleTest()}>
                  {testing ? "Testing..." : "Test OpenAI"}
                </button>
                <button type="button" className="ghost-btn-primary" disabled={testing || saving} onClick={() => void handleSave()}>
                  {saving ? "Saving..." : "Save OpenAI"}
                </button>
              </div>

              {(testResult || testError) && (
                <div className="rounded-lg border border-slate-200 bg-white/85 p-3 text-[0.75rem] text-slate-700 shadow-sm">
                  {testError ? (
                    <p className="text-rose-600">{testError}</p>
                  ) : (
                    <>
                      <p className="font-semibold text-slate-900">Connection test passed</p>
                      <p className="mt-1 text-slate-500">
                        {testResult?.api_mode} on {testResult?.model}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-slate-700">{testResult?.output}</p>
                    </>
                  )}
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
