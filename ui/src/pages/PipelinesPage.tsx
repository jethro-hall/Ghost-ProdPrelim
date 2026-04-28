import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { fetchCollections } from "../api";
import type { Collection, RuntimeDefaults } from "../api";
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
  const [collections, setCollections] = useState<Collection[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (runtimeDefaults) {
      setConfig(runtimeDefaults);
    }
  }, [runtimeDefaults]);

  useEffect(() => {
    void fetchCollections().then(setCollections).catch(() => null);
  }, []);

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
    <div className="pipelines-page space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Parsing pipelines</p>
            <h2 className="mt-1 text-[1rem] font-semibold text-slate-900">Runtime defaults and retrieval policy</h2>
          </div>
          <div className="pipelines-command-bar flex items-center gap-2">
            <button type="button" className="ghost-btn-primary" onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_370px]">
        <section className="glass rounded-xl border border-slate-200 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-[0.84rem] font-semibold text-slate-900">Defaults workspace</h3>
            <div className="text-[0.7rem] text-slate-500">{summary}</div>
          </div>

          <div className="grid gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block text-[0.72rem] text-slate-500">
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
              <label className="block text-[0.72rem] text-slate-500">
                Embedding model
                <input
                  className="ghost-input mt-1"
                  value={config.embedding_model_id}
                  onChange={(event) => update("embedding_model_id", event.target.value)}
                />
              </label>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Default collections</div>
              <div className="grid gap-2 md:grid-cols-2">
                {collections.map((collection) => {
                  const selected = config.default_corpora.includes(collection.slug);
                  return (
                    <label key={collection.id} className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white/70 p-2 text-[0.72rem] text-slate-600">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() =>
                          update(
                            "default_corpora",
                            selected
                              ? config.default_corpora.filter((value) => value !== collection.slug)
                              : [...config.default_corpora, collection.slug],
                          )
                        }
                      />
                      <span>
                        <span className="block font-semibold text-slate-900">{collection.name}</span>
                        <span>{collection.slug}</span>
                      </span>
                    </label>
                  );
                })}
                {collections.length === 0 && <div className="text-[0.72rem] text-slate-500">No managed collections exist yet. Create them in Data Sources first.</div>}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Retrieval controls</div>
              <div className="grid gap-3">
                <ConfigSlider label="Chunk Size" value={config.pdf_chunk_size} min={600} max={1400} step={50} unit="chars" onChange={(value) => update("pdf_chunk_size", value)} />
                <ConfigSlider label="Chunk Overlap" value={config.pdf_chunk_overlap} min={50} max={220} step={10} unit="chars" onChange={(value) => update("pdf_chunk_overlap", value)} />
                <ConfigSlider label="Sentence Window" value={config.pdf_sentence_window} min={1} max={4} step={1} unit="sentences" onChange={(value) => update("pdf_sentence_window", value)} />
                <ConfigSlider label="Top K" value={config.pdf_top_k} min={1} max={20} step={1} unit="nodes" onChange={(value) => update("pdf_top_k", value)} />
              </div>
            </div>
          </div>
        </section>

        <aside className="glass rounded-xl border border-slate-200 p-3">
          <div className="space-y-3">
            <section className="rounded-lg border border-slate-200 bg-white/80 p-2">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Policy</div>
              <label className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-2 text-[0.72rem] text-slate-600">
                <span>Rerank enabled</span>
                <button
                  type="button"
                  onClick={() => update("pdf_rerank_enabled", !config.pdf_rerank_enabled)}
                  className={`h-6 w-11 rounded-full transition ${config.pdf_rerank_enabled ? "bg-[var(--color-accent-neon)]" : "bg-slate-300"}`}
                >
                  <span className={`block h-5 w-5 rounded-full bg-white transition ${config.pdf_rerank_enabled ? "translate-x-5" : "translate-x-0.5"}`} />
                </button>
              </label>
              <label className="mt-2 block text-[0.72rem] text-slate-500">
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
            </section>

            <section className="rounded-lg border border-slate-200 bg-white/80 p-2 text-[0.72rem] text-slate-500">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Save status</div>
              <div>{config.llm_model_id}</div>
              <div className="mt-1">{summary}</div>
              {savedAt && <div className="mt-1">Last saved to the control plane at {savedAt}</div>}
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
