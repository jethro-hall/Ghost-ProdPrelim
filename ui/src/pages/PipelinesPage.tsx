import { useMemo, useState } from "react";

type PipelineConfig = {
  chunkSize: number;
  chunkOverlap: number;
  windowSize: number;
  topK: number;
  rerankEnabled: boolean;
  parseLanePolicy: "local_default" | "cloud_default" | "auto";
};

const STORAGE_KEY = "ghostdash.pipeline-config";
const DEFAULT_CONFIG: PipelineConfig = {
  chunkSize: 1024,
  chunkOverlap: 128,
  windowSize: 3,
  topK: 6,
  rerankEnabled: false,
  parseLanePolicy: "local_default",
};

function loadInitial() {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) return DEFAULT_CONFIG;
  try {
    return { ...DEFAULT_CONFIG, ...(JSON.parse(stored) as Partial<PipelineConfig>) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

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
  const [config, setConfig] = useState<PipelineConfig>(() => loadInitial());
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const summary = useMemo(
    () => `${config.chunkSize}/${config.chunkOverlap} chunking, window ${config.windowSize}, top-k ${config.topK}`,
    [config],
  );

  function update<K extends keyof PipelineConfig>(key: K, value: PipelineConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
  }

  function save() {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    setSavedAt(new Date().toLocaleTimeString());
  }

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5">
        <p className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-400">Parsing Pipelines</p>
        <h2 className="mt-1 text-[1.05rem] font-semibold text-slate-900">Pipeline policy controls</h2>
        <p className="mt-2 text-[0.8rem] leading-6 text-slate-500">
          The designer handover expects these controls to exist. The current live stack does not yet persist them server-side, so this first slice keeps them operator-visible and stored locally until the backend configuration endpoints land.
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <div>
            <h3 className="text-[0.88rem] font-semibold text-slate-900">Node parser</h3>
            <p className="mt-1 text-[0.75rem] text-slate-500">Sentence-window defaults from the designer build guide.</p>
          </div>
          <ConfigSlider label="Chunk Size" value={config.chunkSize} min={256} max={2048} step={64} unit="chars" onChange={(value) => update("chunkSize", value)} />
          <ConfigSlider label="Chunk Overlap" value={config.chunkOverlap} min={0} max={512} step={16} unit="chars" onChange={(value) => update("chunkOverlap", value)} />
          <ConfigSlider label="Window Size" value={config.windowSize} min={1} max={8} step={1} unit="sentences" onChange={(value) => update("windowSize", value)} />
        </article>

        <article className="glass rounded-xl border border-slate-200 p-5 space-y-4">
          <div>
            <h3 className="text-[0.88rem] font-semibold text-slate-900">Retrieval & policy</h3>
            <p className="mt-1 text-[0.75rem] text-slate-500">These values will be promoted to live runtime defaults in the next backend slice.</p>
          </div>
          <ConfigSlider label="Top K" value={config.topK} min={1} max={20} step={1} unit="nodes" onChange={(value) => update("topK", value)} />
          <label className="flex items-center justify-between rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.8rem] text-slate-600">
            <span>Rerank enabled</span>
            <button
              type="button"
              onClick={() => update("rerankEnabled", !config.rerankEnabled)}
              className={`h-6 w-11 rounded-full transition ${config.rerankEnabled ? "bg-[var(--color-accent-neon)]" : "bg-slate-300"}`}
            >
              <span className={`block h-5 w-5 rounded-full bg-white transition ${config.rerankEnabled ? "translate-x-5" : "translate-x-0.5"}`} />
            </button>
          </label>
          <label className="block text-[0.76rem] text-slate-500">
            Parse lane policy
            <select
              value={config.parseLanePolicy}
              onChange={(event) => update("parseLanePolicy", event.target.value as PipelineConfig["parseLanePolicy"])}
              className="ghost-select mt-1"
            >
              <option value="local_default">Local Default (pypdf)</option>
              <option value="cloud_default">Cloud Default (LlamaParse)</option>
              <option value="auto">Auto (Lane Fallback)</option>
            </select>
          </label>
          <button type="button" className="ghost-btn-primary" onClick={save}>Save configuration</button>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3 text-[0.76rem] text-slate-500">
            <div className="font-semibold text-slate-900">Current summary</div>
            <div className="mt-1">{summary}</div>
            {savedAt && <div className="mt-1">Last saved locally at {savedAt}</div>}
          </div>
        </article>
      </div>
    </div>
  );
}
