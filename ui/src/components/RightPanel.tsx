import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ChatApiMode, Connection, ConnectionAuthStrategy, ConnectionTestResult, ProviderKind, RuntimeDefaults } from "../api";
import { testConnection } from "../api";
import { CloseIcon } from "./ReferenceIcons";

type Props = {
  open: boolean;
  onClose: () => void;
  connections: Connection[];
  apiMode: ChatApiMode;
  runtimeDefaults: RuntimeDefaults | null;
  onSaveChatApiMode: (mode: ChatApiMode) => Promise<void>;
  onSave: (connection: {
    provider: string;
    label?: string;
    provider_kind?: ProviderKind;
    auth_strategy?: ConnectionAuthStrategy;
    auth_header_name?: string | null;
    api_key?: string;
    base_url?: string;
    enabled?: boolean;
  }) => Promise<void>;
};

export default function RightPanel({
  open,
  onClose,
  connections,
  apiMode,
  runtimeDefaults,
  onSaveChatApiMode,
  onSave,
}: Props) {
  const [selectedProvider, setSelectedProvider] = useState("openai");
  const [provider, setProvider] = useState("openai");
  const [label, setLabel] = useState("OpenAI");
  const [providerKind, setProviderKind] = useState<ProviderKind>("openai");
  const [authStrategy, setAuthStrategy] = useState<ConnectionAuthStrategy>("bearer");
  const [authHeaderName, setAuthHeaderName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [enabled, setEnabled] = useState(true);
  const [isNewConnection, setIsNewConnection] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [chatApiModeBusy, setChatApiModeBusy] = useState(false);
  const selectedConnection = connections.find((connection) => connection.provider === selectedProvider) ?? null;

  function normalizeProvider(value: string) {
    return value.trim().toLowerCase().replace(/\s+/g, "-");
  }

  function hydrateFormFromConnection(connection: Connection | null) {
    const fallbackProvider = connection?.provider ?? "openai";
    const fallbackLabel = connection?.label ?? "OpenAI";
    setProvider(fallbackProvider);
    setLabel(fallbackLabel);
    setProviderKind(connection?.provider_kind ?? "openai");
    setAuthStrategy(connection?.auth_strategy ?? "bearer");
    setAuthHeaderName(connection?.auth_header_name ?? "");
    setApiKey("");
    setBaseUrl(connection?.base_url ?? "https://api.openai.com/v1");
    setEnabled(connection?.enabled ?? true);
    setTestResult(null);
    setTestError(null);
  }

  useEffect(() => {
    if (!open) return;
    const preferred = connections.find((connection) => connection.provider === "openai") ?? connections[0] ?? null;
    if (preferred) {
      setSelectedProvider(preferred.provider);
      setIsNewConnection(false);
      hydrateFormFromConnection(preferred);
      return;
    }
    setSelectedProvider("openai");
    setIsNewConnection(true);
    hydrateFormFromConnection(null);
  }, [open, connections]);

  useEffect(() => {
    if (!open || isNewConnection) return;
    hydrateFormFromConnection(selectedConnection);
  }, [open, isNewConnection, selectedConnection]);

  async function handleTest() {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await testConnection({
        provider: normalizeProvider(provider),
        label: label || normalizeProvider(provider),
        provider_kind: providerKind,
        auth_strategy: authStrategy,
        auth_header_name: authStrategy === "custom_header" ? authHeaderName || undefined : undefined,
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
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
      const normalizedProvider = normalizeProvider(provider);
      await onSave({
        provider: normalizedProvider,
        label: label || normalizedProvider,
        provider_kind: providerKind,
        auth_strategy: authStrategy,
        auth_header_name: authStrategy === "custom_header" ? authHeaderName || undefined : undefined,
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        enabled,
      });
      setSelectedProvider(normalizedProvider);
      setIsNewConnection(false);
      setApiKey("");
      setTestError(null);
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
            className="glass-popup ghost-scroll connections-panel fixed right-0 top-0 z-50 flex h-full w-full max-w-[390px] flex-col gap-3 overflow-y-auto border-l border-white/60 p-4"
            initial={{ x: "100%", opacity: 0.8 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "100%", opacity: 0.8 }}
            transition={{ type: "spring", stiffness: 280, damping: 30 }}
          >
            <div className="flex items-center justify-between border-b border-black/5 pb-2">
              <div>
                <h2 className="text-[0.98rem] font-semibold text-slate-900">Connections</h2>
              </div>
              <button type="button" aria-label="Close connections panel" className="ghost-icon-btn text-slate-500" onClick={onClose}>
                <CloseIcon size={14} />
              </button>
            </div>

            <div className="flex flex-col gap-2 text-[0.76rem]">
              <div className="rounded-lg border border-slate-200 bg-white/80 p-2">
                <div className="text-[0.72rem] font-semibold text-slate-900">Saved LLM connections</div>
                <div className="mt-2 flex items-center gap-2">
                  <select
                    className="ghost-input flex-1"
                    value={isNewConnection ? "__new__" : selectedProvider}
                    onChange={(event) => {
                      if (event.target.value === "__new__") {
                        setIsNewConnection(true);
                        setSelectedProvider("openai");
                        setProvider("openai");
                        setLabel("OpenAI");
                        setProviderKind("openai");
                        setAuthStrategy("bearer");
                        setAuthHeaderName("");
                        setApiKey("");
                        setBaseUrl("https://api.openai.com/v1");
                        setEnabled(true);
                        setTestResult(null);
                        setTestError(null);
                        return;
                      }
                      setIsNewConnection(false);
                      setSelectedProvider(event.target.value);
                    }}
                  >
                    {connections.map((connection) => (
                      <option key={connection.id} value={connection.provider}>
                        {connection.label} ({connection.provider})
                      </option>
                    ))}
                    <option value="__new__">+ Add new connection</option>
                  </select>
                  <button
                    type="button"
                    className="ghost-btn"
                    onClick={() => {
                      setIsNewConnection(true);
                      setSelectedProvider("openai");
                      setProvider("openai");
                      setLabel("OpenAI");
                      setProviderKind("openai");
                      setAuthStrategy("bearer");
                      setAuthHeaderName("");
                      setApiKey("");
                      setBaseUrl("https://api.openai.com/v1");
                      setEnabled(true);
                      setTestResult(null);
                      setTestError(null);
                    }}
                  >
                    New
                  </button>
                </div>
              </div>

              <label className="font-medium text-slate-600">Provider key</label>
              <input
                className="ghost-input"
                value={provider}
                disabled={!isNewConnection}
                onChange={(event) => setProvider(event.target.value)}
                placeholder="openai, openai-stage, local-llm"
              />
              {!isNewConnection && <div className="text-[0.66rem] text-slate-500">Provider key is fixed for existing records.</div>}

              <label className="font-medium text-slate-600">Provider kind</label>
              <select
                className="ghost-input"
                value={providerKind}
                onChange={(event) => {
                  const next = event.target.value as ProviderKind;
                  setProviderKind(next);
                  if (next !== "google_gemini") return;

                  if (isNewConnection) {
                    if (!provider.trim() || provider === "openai") setProvider("google-gemini");
                    if (!label.trim() || label === "OpenAI") setLabel("Google Gemini");
                  }

                  // Match Google's native REST `:generateContent` examples.
                  if (baseUrl.includes("api.openai.com") || baseUrl.includes("one.rideai.com.au")) {
                    setBaseUrl("https://generativelanguage.googleapis.com/v1beta");
                  }
                  if (authStrategy === "x_api_key") setAuthStrategy("x_goog_api_key");
                }}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Claude / Anthropic</option>
                <option value="google_gemini">Google Gemini</option>
                <option value="openai_compatible">OpenAI-compatible / self-hosted</option>
              </select>

              <label className="font-medium text-slate-600">Label</label>
              <input className="ghost-input" value={label} onChange={(event) => setLabel(event.target.value)} />

              <label className="font-medium text-slate-600">Auth strategy</label>
              <select
                className="ghost-input"
                value={authStrategy}
                onChange={(event) => setAuthStrategy(event.target.value as ConnectionAuthStrategy)}
              >
                <option value="bearer">Bearer token</option>
                <option value="x_api_key">x-api-key header</option>
                <option value="x_goog_api_key">x-goog-api-key header (Gemini)</option>
                <option value="custom_header">Custom header</option>
              </select>

              {authStrategy === "custom_header" && (
                <>
                  <label className="font-medium text-slate-600">Custom auth header</label>
                  <input
                    className="ghost-input"
                    value={authHeaderName}
                    onChange={(event) => setAuthHeaderName(event.target.value)}
                    placeholder="X-Internal-Key"
                  />
                </>
              )}

              <label className="font-medium text-slate-600">API key</label>
              <input
                type="password"
                className="ghost-input"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={selectedConnection?.has_api_key ? "leave blank to keep saved key" : "sk-..."}
              />

              <label className="font-medium text-slate-600">Base URL</label>
              <input className="ghost-input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              <label className="flex items-center gap-2 text-[0.76rem] text-slate-500">
                <input type="checkbox" checked={enabled} onChange={() => setEnabled((value) => !value)} />
                Enabled
              </label>

              <div className="rounded-lg border border-slate-200 bg-white/80 p-2 text-[0.72rem] leading-5 text-slate-600">
                <div className="font-semibold text-slate-900">OpenAI API path</div>
                <label className="mt-2 block text-[0.72rem] font-medium text-slate-700">Default chat API mode</label>
                <select
                  className="ghost-input mt-1"
                  disabled={!runtimeDefaults || chatApiModeBusy}
                  value={runtimeDefaults?.chat_api_mode ?? apiMode}
                  onChange={(event) => {
                    const next = event.target.value as ChatApiMode;
                    setChatApiModeBusy(true);
                    void onSaveChatApiMode(next)
                      .catch(() => null)
                      .finally(() => setChatApiModeBusy(false));
                  }}
                >
                  <option value="responses">Responses API</option>
                  <option value="chat_completions">Chat Completions API</option>
                </select>
                <p className="mt-2 text-[0.66rem] text-slate-500">
                  This updates the <strong>default</strong> runtime profile (same as{" "}
                  <Link className="font-medium text-slate-700 underline" to="/pipelines">
                    Parsing Pipelines
                  </Link>
                  ). Each agent can override this under{" "}
                  <Link className="font-medium text-slate-700 underline" to="/agent">
                    Agent config
                  </Link>
                  .
                </p>
                <p className="mt-2 text-[0.66rem] text-slate-500">
                  Connections only store base URL and credentials; choose <strong>Responses</strong> for current OpenAI ChatGPT-class models on <code className="rounded bg-slate-100 px-1">api.openai.com</code>.
                </p>
              </div>

              <div className="mt-1 flex items-center gap-2">
                <button type="button" className="ghost-btn" disabled={testing || saving} onClick={() => void handleTest()}>
                  {testing ? "Testing..." : "Test connection"}
                </button>
                <button type="button" className="ghost-btn-primary" disabled={testing || saving} onClick={() => void handleSave()}>
                  {saving ? "Saving..." : isNewConnection ? "Add connection" : "Save connection"}
                </button>
              </div>

              {(testResult || testError) && (
                <div className="rounded-lg border border-slate-200 bg-white/85 p-2 text-[0.72rem] text-slate-700 shadow-sm">
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
