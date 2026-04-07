import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import type { RuntimeDefaults } from "../api";
import type { AppOutletContext } from "../components/AppLayout";

function ConfigSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[0.76rem] text-slate-500">
        <span>{label}</span>
        <span className="font-semibold text-slate-900">{value} {unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(parseInt(event.target.value, 10))}
        className="w-full accent-[var(--color-accent-neon)]"
      />
    </div>
  );
}

export default function PipelinesPage() {
  const { runtimeDefaults, saveRuntimeDefaults } = useOutletContext<AppOutletContext>();
  const [config, setConfig] = useState<RuntimeDefaults | null>(runtimeDefaults);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (runtimeDefaults) {
      setConfig(runtimeDefaults);
    }
  }, [runtimeDefaults]);

  const summary = useMemo(
    () =>
      config
        ? `${config.pdf_chunk_size}/${config.pdf_chunk_overlap} chunking, window ${config.pdf_sentence_window}, top-k ${config.pdf_top_k}`
        : "Loading runtime defaults...",
    [config],
  );

  function update<K extends keyof RuntimeDefaults>(key: K, value: RuntimeDefaults[K]) {
    setConfig((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save() {
    if (!config) return;
    await saveRuntimeDefaults(config);
    setSavedAt(new Date().toLocaleTimeString());
  }

  if (!config) {
    return (
      <div className="glass rounded-xl border border-slate-200 p-5 text-[0.82rem] text-slate-500">
        Loading runtime defaults...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Parsing Pipelines</p>
        <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Runtime defaults and retrieval policy</h2>
        <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
          This page is now the single editable surface for default retrieval, embedding, corpora, and chat API mode. Agent-specific persona and tool policy stay in Agent Config.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <div>
            <h3 className="text-[0.88rem] font-semibold text-slate-900">Knowledge base binding</h3>
            <p className="mt-1 text-[0.75rem] text-slate-500">These defaults are used when a chat request does not provide explicit corpora or embedding settings.</p>
          </div>
          <label className="block text-[0.76rem] text-slate-500">
            Chat API mode
            <select
              className="ghost-select mt-1"
              value={config.chat_api_mode}
              onChange={(event) => update("chat_api_mode", event.target.value as RuntimeDefaults["chat_api_mode"])}
            >
              <option value="responses">Responses API</option>
              <option value="chat_completions">Chat Completions API</option>
            </select>
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Embedding model
            <input
              className="ghost-input mt-1"
              value={config.embedding_model_id}
              onChange={(event) => update("embedding_model_id", event.target.value)}
            />
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Default corpora
            <input
              className="ghost-input mt-1"
              value={config.default_corpora.join(", ")}
              onChange={(event) =>
                update(
                  "default_corpora",
                  event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                )
              }
            />
          </label>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.76rem] text-slate-500">
            <div className="font-semibold text-slate-900">Default LLM model</div>
            <div className="mt-1">{config.llm_model_id}</div>
            <div className="mt-1">Change the default agent model from Agent Config so there is only one edit surface for LLM runtime.</div>
          </div>
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <div>
            <h3 className="text-[0.88rem] font-semibold text-slate-900">Retrieval & policy</h3>
            <p className="mt-1 text-[0.75rem] text-slate-500">These values are persisted through the control plane and drive the default runtime profile used by ingestion and chat.</p>
          </div>
          <ConfigSlider label="Chunk Size" value={config.pdf_chunk_size} min={600} max={1400} step={50} unit="chars" onChange={(value) => update("pdf_chunk_size", value)} />
          <ConfigSlider label="Chunk Overlap" value={config.pdf_chunk_overlap} min={50} max={220} step={10} unit="chars" onChange={(value) => update("pdf_chunk_overlap", value)} />
          <ConfigSlider label="Sentence Window" value={config.pdf_sentence_window} min={1} max={4} step={1} unit="sentences" onChange={(value) => update("pdf_sentence_window", value)} />
          <ConfigSlider label="Top K" value={config.pdf_top_k} min={1} max={20} step={1} unit="nodes" onChange={(value) => update("pdf_top_k", value)} />
          <label className="flex items-center justify-between rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.8rem] text-slate-600">
            <span>Rerank enabled</span>
            <button
              type="button"
              onClick={() => update("pdf_rerank_enabled", !config.pdf_rerank_enabled)}
              className={`h-6 w-11 rounded-full transition ${config.pdf_rerank_enabled ? "bg-[var(--color-accent-neon)]" : "bg-slate-300"}`}
            >
              <span className={`block h-5 w-5 rounded-full bg-white transition ${config.pdf_rerank_enabled ? "translate-x-5" : "translate-x-0.5"}`} />
            </button>
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Parse lane policy
            <select
              value={config.pdf_parse_lane_policy}
              onChange={(event) => update("pdf_parse_lane_policy", event.target.value as RuntimeDefaults["pdf_parse_lane_policy"])}
              className="ghost-select mt-1"
            >
              <option value="local_default">Local Default (pypdf)</option>
              <option value="cloud_default">Cloud Default (LlamaParse)</option>
              <option value="auto">Auto (Lane Fallback)</option>
            </select>
          </label>
          <button type="button" className="ghost-btn-primary" onClick={() => void save()}>Save configuration</button>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.76rem] text-slate-500">
            <div className="font-semibold text-slate-900">Current summary</div>
            <div className="mt-1">{summary}</div>
            {savedAt && <div className="mt-1">Last saved to the control plane at {savedAt}</div>}
          </div>
        </article>
      </div>
    </div>
  );
}
