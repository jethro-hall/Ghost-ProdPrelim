import { AnimatePresence, motion } from "framer-motion";
import axios from "axios";
import { useEffect, useMemo, useState } from "react";
import type {
  BedrockModelItem,
  ChatApiMode,
  Connection,
  ConnectionAuthStrategy,
  ConnectionDeletionPreview,
  ConnectionTestResult,
  ProviderKind,
  RuntimeDefaults,
} from "../api";
import { fetchConnectionDeletionPreview, listBedrockModels, testConnection } from "../api";
import { defaultModelIdForProviderKind, PRESET_MODEL_IDS_BY_KIND } from "../lib/modelIdMemory";
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
    default_model_id?: string | null;
    aws_region?: string | null;
  }) => Promise<void>;
  onDelete: (connectionId: string, confirmationToken: string) => Promise<void>;
};

export default function RightPanel({
  open,
  onClose,
  connections,
  apiMode,
  runtimeDefaults,
  onSaveChatApiMode,
  onSave,
  onDelete,
}: Props) {
  const [selectedProvider, setSelectedProvider] = useState("openai");
  const [provider, setProvider] = useState("openai");
  const [label, setLabel] = useState("OpenAI");
  const [providerKind, setProviderKind] = useState<ProviderKind>("openai");
  const [authStrategy, setAuthStrategy] = useState<ConnectionAuthStrategy>("bearer");
  const [authHeaderName, setAuthHeaderName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [enabled, setEnabled] = useState(true);
  const [bedrockBrowseOpen, setBedrockBrowseOpen] = useState(false);
  const [bedrockBrowseModels, setBedrockBrowseModels] = useState<BedrockModelItem[]>([]);
  const [bedrockBrowseLoading, setBedrockBrowseLoading] = useState(false);
  const [bedrockBrowseError, setBedrockBrowseError] = useState<string | null>(null);
  const [bedrockBrowseSearch, setBedrockBrowseSearch] = useState("");
  const [testModelId, setTestModelId] = useState("");
  const [isNewConnection, setIsNewConnection] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [testApiMode, setTestApiMode] = useState<ChatApiMode>(apiMode);
  const [chatApiModeBusy, setChatApiModeBusy] = useState(false);
  const [chatApiModeError, setChatApiModeError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletePreview, setDeletePreview] = useState<ConnectionDeletionPreview | null>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const selectedConnection = connections.find((connection) => connection.provider === selectedProvider) ?? null;

  function normalizeProvider(value: string) {
    return value.trim().toLowerCase().replace(/\s+/g, "-");
  }

  function isLikelyOllamaBaseUrl(value: string) {
    const base = value.trim().toLowerCase();
    return (
      base.includes("ollama") ||
      base.includes(":11434") ||
      base.includes("localhost:11434") ||
      base.includes("127.0.0.1:11434") ||
      base.includes("host.docker.internal:11434")
    );
  }

  function effectiveProviderKind(rawKind: ProviderKind, url: string): ProviderKind {
    if (rawKind === "google_gemini" && isLikelyOllamaBaseUrl(url)) {
      return "openai_compatible";
    }
    return rawKind;
  }

  function runtimeDefaultModelForKind(kind: ProviderKind): string {
    if (runtimeDefaults?.llm_provider_kind === kind) {
      const runtimeModel = runtimeDefaults.llm_model_id?.trim();
      if (runtimeModel) {
        return runtimeModel;
      }
    }
    return defaultModelIdForProviderKind(kind, null);
  }

  function shouldSwapToGeminiDefault(currentModel: string): boolean {
    const trimmed = currentModel.trim().toLowerCase();
    if (!trimmed) {
      return true;
    }
    if (trimmed.startsWith("google/") || trimmed.startsWith("gemini")) {
      return false;
    }
    return (
      trimmed.startsWith("openai/") ||
      trimmed.startsWith("gpt-") ||
      trimmed.startsWith("o1") ||
      trimmed.startsWith("o3") ||
      trimmed.startsWith("llama")
    );
  }

  function isRideAiGatewayBaseUrl(value: string) {
    try {
      const url = new URL(value.trim() || "https://example.com");
      return url.hostname.toLowerCase() === "one.rideai.com.au";
    } catch {
      return false;
    }
  }

  function recommendedConnectionTestApiMode(kind: ProviderKind, url: string, fallback: ChatApiMode): ChatApiMode {
    if (kind === "openai_compatible" || isRideAiGatewayBaseUrl(url) || isLikelyOllamaBaseUrl(url)) {
      return "chat_completions";
    }
    return fallback;
  }

  function extractApiErrorMessage(error: unknown) {
    if (axios.isAxiosError(error)) {
      const responseData = error.response?.data;
      if (typeof responseData === "string" && responseData.trim()) {
        return responseData;
      }
      if (responseData && typeof responseData === "object") {
        const detail = (responseData as { detail?: unknown }).detail;
        if (typeof detail === "string" && detail.trim()) {
          return detail;
        }
      }
      if (error.response?.status === 401 || error.response?.status === 403) {
        return "Connection test failed: authentication with provider was rejected.";
      }
      if (error.code === "ERR_NETWORK") {
        return "Connection test failed: GhostDASH API is unreachable.";
      }
      if (typeof error.message === "string" && error.message.trim()) {
        return error.message;
      }
    }

    const responseData = (error as { response?: { data?: unknown } }).response?.data;
    if (typeof responseData === "string" && responseData.trim()) {
      return responseData;
    }
    if (responseData && typeof responseData === "object") {
      const detail = (responseData as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail.trim()) {
        return detail;
      }
    }
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }
    return "Connection test failed.";
  }

  function hydrateFormFromConnection(connection: Connection | null) {
    const fallbackProvider = connection?.provider ?? "openai";
    const fallbackLabel = connection?.label ?? "OpenAI";
    const fallbackKind = connection?.provider_kind ?? "openai";
    const fallbackModel = connection?.default_model_id ?? runtimeDefaultModelForKind(fallbackKind);
    setProvider(fallbackProvider);
    setLabel(fallbackLabel);
    setProviderKind(fallbackKind);
    setAuthStrategy(connection?.auth_strategy ?? "bearer");
    setAuthHeaderName(connection?.auth_header_name ?? "");
    setApiKey("");
    setBaseUrl(connection?.base_url ?? "https://api.openai.com/v1");
    setAwsRegion(connection?.aws_region ?? "us-east-1");
    setEnabled(connection?.enabled ?? true);
    setTestModelId(fallbackModel);
    setTestResult(null);
    setTestError(null);
    setSaveError(null);
    setDeleteError(null);
    setDeletePreview(null);
    setDeleteModalOpen(false);
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
  }, [open, connections, runtimeDefaults?.llm_model_id]);

  useEffect(() => {
    if (!open || isNewConnection) return;
    hydrateFormFromConnection(selectedConnection);
  }, [open, isNewConnection, selectedConnection, runtimeDefaults?.llm_model_id]);

  const activeProviderKind = effectiveProviderKind(providerKind, baseUrl);

  useEffect(() => {
    if (!open) return;
    setTestApiMode(recommendedConnectionTestApiMode(activeProviderKind, baseUrl, runtimeDefaults?.chat_api_mode ?? apiMode));
    setChatApiModeError(null);
  }, [open, activeProviderKind, baseUrl, selectedProvider, runtimeDefaults?.chat_api_mode, apiMode]);

  const modelQuickPickOptions = useMemo(() => {
    const merged = new Set<string>([
      ...(PRESET_MODEL_IDS_BY_KIND[activeProviderKind] ?? []),
      selectedConnection?.default_model_id?.trim() ?? "",
      runtimeDefaultModelForKind(activeProviderKind),
      testModelId.trim(),
    ]);
    return [...merged].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [activeProviderKind, selectedConnection?.default_model_id, testModelId, runtimeDefaults?.llm_model_id, runtimeDefaults?.llm_provider_kind]);

  const modelQuickPickValue = useMemo(() => {
    const current = testModelId.trim();
    if (!current) {
      return "";
    }
    return modelQuickPickOptions.includes(current) ? current : "";
  }, [modelQuickPickOptions, testModelId]);

  async function handleTest() {
    setTesting(true);
    setTestError(null);
    setSaveError(null);
    setDeleteError(null);
    setTestResult(null);
    try {
      const normalizedModel = testModelId.trim();
      const nextProviderKind = effectiveProviderKind(providerKind, baseUrl);
      if (isLikelyOllamaBaseUrl(baseUrl) && normalizedModel.toLowerCase().startsWith("gemini")) {
        setTestError("Ollama does not serve Gemini models. Use an installed Ollama model tag (for example: llama3.1:8b).");
        return;
      }
      const result = await testConnection({
        provider: normalizeProvider(provider),
        label: label || normalizeProvider(provider),
        provider_kind: nextProviderKind,
        auth_strategy: authStrategy,
        auth_header_name: authStrategy === "custom_header" ? authHeaderName || undefined : undefined,
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        aws_region: nextProviderKind === "amazon_bedrock" ? awsRegion || undefined : undefined,
        model_id: normalizedModel || undefined,
        api_mode: testApiMode,
      });
      setTestResult(result);
      if (nextProviderKind !== providerKind) {
        setProviderKind(nextProviderKind);
      }
    } catch (error) {
      setTestError(extractApiErrorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setTestError(null);
    setDeleteError(null);
    try {
      const normalizedProvider = normalizeProvider(provider);
      const nextProviderKind = effectiveProviderKind(providerKind, baseUrl);
      await onSave({
        provider: normalizedProvider,
        label: label || normalizedProvider,
        provider_kind: nextProviderKind,
        auth_strategy: authStrategy,
        auth_header_name: authStrategy === "custom_header" ? authHeaderName || undefined : undefined,
        api_key: apiKey || undefined,
        base_url: baseUrl || undefined,
        enabled,
        default_model_id: testModelId.trim() || null,
        aws_region: nextProviderKind === "amazon_bedrock" ? awsRegion || "us-east-1" : undefined,
      });
      setSelectedProvider(normalizedProvider);
      setIsNewConnection(false);
      setApiKey("");
      if (nextProviderKind !== providerKind) {
        setProviderKind(nextProviderKind);
      }
    } catch (error) {
      setSaveError(extractApiErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (isNewConnection || !selectedConnection) {
      return;
    }
    setDeleteError(null);
    setSaveError(null);
    setTestError(null);
    setDeleting(true);
    try {
      const preview = await fetchConnectionDeletionPreview(selectedConnection.id);
      setDeletePreview(preview);
      setDeleteModalOpen(true);
    } catch (error) {
      setDeleteError(extractApiErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  async function handleConfirmDelete() {
    if (!selectedConnection || !deletePreview?.can_execute) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(selectedConnection.id, deletePreview.confirmation_token);
      setDeleteModalOpen(false);
      setDeletePreview(null);
      setIsNewConnection(true);
      hydrateFormFromConnection(null);
    } catch (error) {
      setDeleteError(extractApiErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  function formatDeleteReason(reason: string) {
    return reason.replaceAll("_", " ");
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
                        setTestModelId(runtimeDefaults?.llm_model_id ?? "");
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
                      setTestModelId(runtimeDefaults?.llm_model_id ?? "");
                      setTestResult(null);
                      setTestError(null);
                    }}
                  >
                    New
                  </button>
                  {!isNewConnection && (
                    <button
                      type="button"
                      className="ghost-btn border-rose-200 text-rose-700 hover:border-rose-300 hover:text-rose-800"
                      disabled={testing || saving || deleting}
                      onClick={() => void handleDelete()}
                    >
                    {deleting ? "Loading..." : "Delete provider"}
                    </button>
                  )}
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
                  if (next === "google_gemini") {
                    if (isNewConnection) {
                      if (!provider.trim() || provider === "openai") setProvider("google-gemini");
                      if (!label.trim() || label === "OpenAI") setLabel("Google Gemini");
                    }

                    // Match Google's native REST `:generateContent` examples.
                    if (baseUrl.includes("api.openai.com") || baseUrl.includes("one.rideai.com.au")) {
                      setBaseUrl("https://generativelanguage.googleapis.com/v1beta");
                    }
                    if (authStrategy === "x_api_key") setAuthStrategy("x_goog_api_key");
                    if (shouldSwapToGeminiDefault(testModelId)) {
                      setTestModelId(runtimeDefaultModelForKind("google_gemini"));
                    }
                    return;
                  }

                  if (next === "amazon_bedrock") {
                    if (isNewConnection) {
                      if (!provider.trim() || provider === "openai") setProvider("amazon-bedrock");
                      if (!label.trim() || label === "OpenAI") setLabel("Amazon Bedrock");
                    }
                    setAuthStrategy("custom_header");
                    setBaseUrl("");
                    if (!testModelId.trim()) {
                      setTestModelId(runtimeDefaultModelForKind("amazon_bedrock"));
                    }
                    return;
                  }

                  if (!testModelId.trim()) {
                    setTestModelId(runtimeDefaultModelForKind(next));
                  }
                }}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Claude / Anthropic</option>
                <option value="google_gemini">Google Gemini</option>
                <option value="openai_compatible">OpenAI-compatible / self-hosted</option>
                <option value="amazon_bedrock">Amazon Bedrock</option>
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
              <label className="font-medium text-slate-600">Test model id</label>
              <select
                className="ghost-input mb-1"
                aria-label="Quick pick test model id"
                value={modelQuickPickValue}
                onChange={(event) => {
                  if (!event.target.value) return;
                  setTestModelId(event.target.value);
                }}
              >
                <option value="">Quick pick model id</option>
                {modelQuickPickOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <input
                className="ghost-input"
                value={testModelId}
                onChange={(event) => setTestModelId(event.target.value)}
                placeholder="Only used for connection tests"
              />
              <div className="text-[0.66rem] text-slate-500">
                Saved per connection. Used as the default model for connection tests; clear the field to fall back to the global default model from runtime defaults.
              </div>
              {activeProviderKind === "google_gemini" && (
                <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[0.66rem] text-emerald-800">
                  Gemini provider selected. Use a Gemini model id such as <code>gemini-2.0-flash</code> or <code>google/gemini-2.0-flash</code>.
                </div>
              )}
              {activeProviderKind === "amazon_bedrock" && (
                <>
                  <label className="font-medium text-slate-600">
                    AWS Region
                  </label>
                  <input
                    className="ghost-input"
                    value={awsRegion}
                    onChange={(event) => setAwsRegion(event.target.value)}
                    placeholder="us-east-1"
                  />
                  <div className="rounded border border-sky-200 bg-sky-50 px-2 py-1 text-[0.66rem] text-sky-800">
                    Amazon Bedrock — no Base URL needed. Set <strong>Auth header name</strong> to your AWS Access Key ID and <strong>API key</strong> to your AWS Secret Access Key. Model id must be a Bedrock inference profile ID such as <code>us.anthropic.claude-sonnet-4-5-20251101-v1:0</code>.
                  </div>
                  <button
                    type="button"
                    className="ghost-button mt-1"
                    disabled={bedrockBrowseLoading}
                    onClick={async () => {
                      setBedrockBrowseOpen(true);
                      setBedrockBrowseLoading(true);
                      setBedrockBrowseError(null);
                      setBedrockBrowseSearch("");
                      try {
                        const resp = await listBedrockModels({
                          provider: normalizeProvider(provider),
                          access_key_id: authHeaderName || undefined,
                          secret_access_key: apiKey || undefined,
                          aws_region: awsRegion || undefined,
                        });
                        if (resp.error) {
                          setBedrockBrowseError(resp.error);
                          setBedrockBrowseModels([]);
                        } else {
                          setBedrockBrowseModels(resp.models);
                        }
                      } catch (error) {
                        setBedrockBrowseError(
                          error instanceof Error ? error.message : "Failed to list Bedrock models",
                        );
                        setBedrockBrowseModels([]);
                      } finally {
                        setBedrockBrowseLoading(false);
                      }
                    }}
                  >
                    {bedrockBrowseLoading ? "Loading…" : "Browse my inference models"}
                  </button>

                  <AnimatePresence>
                    {bedrockBrowseOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="rounded-lg border border-sky-200 bg-white/95 p-3 shadow-md"
                      >
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-[0.76rem] font-semibold text-slate-800">
                            Available models — click to use
                          </span>
                          <button
                            type="button"
                            className="text-slate-400 hover:text-slate-700"
                            onClick={() => setBedrockBrowseOpen(false)}
                          >
                            ✕
                          </button>
                        </div>
                        {bedrockBrowseError && (
                          <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-[0.66rem] text-red-800">
                            {bedrockBrowseError}
                          </div>
                        )}
                        {!bedrockBrowseLoading && bedrockBrowseModels.length > 0 && (
                          <input
                            className="ghost-input mb-2 text-[0.72rem]"
                            placeholder="Filter models…"
                            value={bedrockBrowseSearch}
                            onChange={(event) => setBedrockBrowseSearch(event.target.value)}
                          />
                        )}
                        {bedrockBrowseLoading && (
                          <div className="py-4 text-center text-[0.72rem] text-slate-500">
                            Loading from AWS…
                          </div>
                        )}
                        {!bedrockBrowseLoading && bedrockBrowseModels.length === 0 && !bedrockBrowseError && (
                          <div className="py-2 text-[0.72rem] text-slate-500">
                            No models found. Check credentials and region.
                          </div>
                        )}
                        {!bedrockBrowseLoading && (
                          <div className="max-h-64 overflow-y-auto space-y-0.5">
                            {bedrockBrowseModels
                              .filter((m) => {
                                const q = bedrockBrowseSearch.toLowerCase();
                                return (
                                  !q ||
                                  m.model_id.toLowerCase().includes(q) ||
                                  m.model_name.toLowerCase().includes(q) ||
                                  m.provider.toLowerCase().includes(q)
                                );
                              })
                              .map((m) => (
                                <button
                                  key={m.model_id}
                                  type="button"
                                  className="flex w-full flex-col rounded px-2 py-1 text-left hover:bg-sky-50 focus:bg-sky-50"
                                  onClick={() => {
                                    setTestModelId(m.model_id);
                                    setBedrockBrowseOpen(false);
                                  }}
                                >
                                  <span className="font-mono text-[0.68rem] text-sky-700">{m.model_id}</span>
                                  <span className="text-[0.63rem] text-slate-500">
                                    {m.model_name}
                                    {m.kind === "inference_profile" && (
                                      <span className="ml-1 rounded bg-emerald-100 px-1 text-emerald-700">profile</span>
                                    )}
                                  </span>
                                </button>
                              ))}
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
              {isLikelyOllamaBaseUrl(baseUrl) && (
                <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[0.66rem] text-amber-800">
                  Ollama endpoints are OpenAI-compatible. Use provider kind <strong>OpenAI-compatible / self-hosted</strong> and an
                  Ollama model tag (not <code>gemini-pro</code>).
                </div>
              )}
              <label className="flex items-center gap-2 text-[0.76rem] text-slate-500">
                <input type="checkbox" checked={enabled} onChange={() => setEnabled((value) => !value)} />
                Enabled
              </label>

              <div className="rounded-lg border border-slate-200 bg-white/80 p-2 text-[0.72rem] leading-5 text-slate-600">
                <div className="font-semibold text-slate-900">Connection test API mode</div>
                <label className="mt-2 block text-[0.72rem] font-medium text-slate-700">Use for Test connection</label>
                <select
                  className="ghost-input mt-1"
                  disabled={testing}
                  value={testApiMode}
                  onChange={(event) => {
                    setTestApiMode(event.target.value as ChatApiMode);
                    setTestError(null);
                  }}
                >
                  <option value="responses">Responses API</option>
                  <option value="chat_completions">Chat Completions API</option>
                </select>
                <p className="mt-2 text-[0.66rem] text-slate-500">
                  Self-hosted and RideAI gateways should use <strong>Chat Completions</strong>. Responses is for native{" "}
                  <code className="rounded bg-slate-100 px-1">api.openai.com</code> models only.
                </p>
                {isRideAiGatewayBaseUrl(baseUrl) && (
                  <p className="mt-2 text-[0.66rem] text-amber-800">
                    RideAI gateway detected. Base URL should be <code className="rounded bg-amber-100 px-1">https://one.rideai.com.au/v1</code>{" "}
                    and model ids are case-sensitive (for example <code className="rounded bg-amber-100 px-1">RE-JH-LLM05</code>).
                  </p>
                )}
                <div className="mt-3 border-t border-slate-200 pt-2">
                  <div className="text-[0.66rem] font-medium text-slate-700">
                    Workspace default: {runtimeDefaults?.chat_api_mode ?? apiMode}
                  </div>
                  <button
                    type="button"
                    className="ghost-btn mt-2"
                    disabled={!runtimeDefaults || chatApiModeBusy || testApiMode === runtimeDefaults?.chat_api_mode}
                    onClick={() => {
                      if (!runtimeDefaults) return;
                      setChatApiModeBusy(true);
                      setChatApiModeError(null);
                      void onSaveChatApiMode(testApiMode)
                        .catch((error) => setChatApiModeError(extractApiErrorMessage(error)))
                        .finally(() => setChatApiModeBusy(false));
                    }}
                  >
                    {chatApiModeBusy ? "Saving..." : "Use test mode as workspace default"}
                  </button>
                  {chatApiModeError && <p className="mt-2 text-[0.66rem] text-rose-600">{chatApiModeError}</p>}
                </div>
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
              {saveError && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-[0.72rem] text-rose-700 shadow-sm">
                  {saveError}
                </div>
              )}
              {deleteError && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-[0.72rem] text-rose-700 shadow-sm">
                  {deleteError}
                </div>
              )}
            </div>
          </motion.aside>

          <AnimatePresence>
            {deleteModalOpen && selectedConnection && deletePreview && (
              <>
                <motion.button
                  type="button"
                  aria-label="Close delete provider modal"
                  className="fixed inset-0 z-[60] bg-black/45 backdrop-blur-[1px]"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setDeleteModalOpen(false)}
                />
                <motion.div
                  className="fixed inset-0 z-[61] flex items-center justify-center p-4"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                >
                  <div className="w-full max-w-[620px] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
                    <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
                      <div>
                        <h3 className="text-[1rem] font-semibold text-slate-900">Delete provider review</h3>
                        <p className="mt-1 text-[0.74rem] text-slate-600">
                          {selectedConnection.label} ({selectedConnection.provider})
                        </p>
                      </div>
                      <button
                        type="button"
                        className="ghost-icon-btn text-slate-500"
                        onClick={() => setDeleteModalOpen(false)}
                        aria-label="Close delete provider review"
                      >
                        <CloseIcon size={14} />
                      </button>
                    </div>

                    {deletePreview.can_execute ? (
                      <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-[0.72rem] text-emerald-800">
                        Ready to delete. No blocking references were detected.
                      </div>
                    ) : (
                      <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2 text-[0.72rem] text-rose-800">
                        <p className="font-semibold">Deletion blocked</p>
                        <ul className="mt-1 list-disc pl-4">
                          {deletePreview.blocking_reasons.map((reason) => (
                            <li key={reason}>{formatDeleteReason(reason)}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="text-[0.72rem] font-semibold uppercase tracking-[0.12em] text-slate-500">Blast radius</div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-[0.74rem] text-slate-700 md:grid-cols-3">
                        <div>Runtime direct refs: {deletePreview.impact.runtime_profile_direct_refs}</div>
                        <div>Runtime provider refs: {deletePreview.impact.runtime_profile_provider_refs}</div>
                        <div>Fallback direct refs: {deletePreview.impact.runtime_profile_fallback_refs}</div>
                        <div>Fallback provider refs: {deletePreview.impact.runtime_profile_fallback_provider_refs}</div>
                        <div>Agents impacted: {deletePreview.impact.agents_impacted}</div>
                        <div>Active workflow runs: {deletePreview.impact.active_workflow_runs}</div>
                        <div>Active workflow steps: {deletePreview.impact.active_workflow_steps}</div>
                        <div>Runtime default link: {deletePreview.impact.is_runtime_default_connection ? "yes" : "no"}</div>
                        <div>Seeded provider: {deletePreview.impact.seeded_provider_key ? "yes" : "no"}</div>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center justify-end gap-2">
                      <button type="button" className="ghost-btn" onClick={() => setDeleteModalOpen(false)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="ghost-btn border-rose-200 text-rose-700 hover:border-rose-300 hover:text-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!deletePreview.can_execute || deleting}
                        onClick={() => void handleConfirmDelete()}
                      >
                        {deleting ? "Deleting..." : "Delete provider now"}
                      </button>
                    </div>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </>
      )}
    </AnimatePresence>
  );
}
