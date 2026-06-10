import { useEffect, useMemo, useState } from "react";

import {
  fetchElevenLabsSimulation,
  fetchElevenLabsSimulations,
  type ElevenLabsSimulationDetailResponse,
  type ElevenLabsSimulationItem,
} from "../api";

export default function ElevenLabsSimulationPacksPage() {
  const [loading, setLoading] = useState(true);
  const [busyDetail, setBusyDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ElevenLabsSimulationItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [detail, setDetail] = useState<ElevenLabsSimulationDetailResponse | null>(null);
  const [copied, setCopied] = useState(false);

  async function loadList(query?: string) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchElevenLabsSimulations({ search: query, limit: 500 });
      setItems(response.items);
      if (!selectedFile && response.items.length > 0) {
        setSelectedFile(response.items[0].file_name);
      }
    } catch {
      setError("Simulation pack list is unavailable right now.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(fileName: string) {
    setBusyDetail(true);
    setError(null);
    try {
      const response = await fetchElevenLabsSimulation(fileName);
      setDetail(response);
    } catch {
      setError("Selected simulation could not be loaded.");
      setDetail(null);
    } finally {
      setBusyDetail(false);
    }
  }

  useEffect(() => {
    void loadList();
  }, []);

  useEffect(() => {
    if (!selectedFile) return;
    void loadDetail(selectedFile);
  }, [selectedFile]);

  const selectedMeta = useMemo(() => items.find((item) => item.file_name === selectedFile) ?? null, [items, selectedFile]);

  async function copyStrictJson() {
    if (!detail?.elevenlabs_test_payload_pretty) return;
    try {
      await navigator.clipboard.writeText(detail.elevenlabs_test_payload_pretty);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Copy failed. Please select and copy manually.");
    }
  }

  async function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadList(search.trim() || undefined);
  }

  return (
    <div className="space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-4">
        <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Call Analysis</p>
        <h2 className="mt-1 text-[1rem] font-semibold text-slate-900">ElevenLabs Simulation Packs</h2>
        <p className="mt-2 text-[0.82rem] text-slate-600">
          Select any generated call simulation and copy strict JSON for the ElevenLabs testing editor.
        </p>
        <form className="mt-3 flex gap-2" onSubmit={(event) => void handleSearchSubmit(event)}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by user, summary, or conversation id"
            className="glass-input w-full rounded-md px-3 py-2 text-[0.8rem]"
          />
          <button type="submit" className="glass-button rounded-md px-3 py-2 text-[0.78rem] font-semibold">
            Search
          </button>
          <button type="button" className="glass-button rounded-md px-3 py-2 text-[0.78rem]" onClick={() => void loadList()}>
            Reset
          </button>
        </form>
      </section>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-[0.78rem] text-rose-700">{error}</div>}

      <section className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="glass rounded-xl border border-slate-200 px-3 py-3">
          <p className="text-[0.64rem] font-bold uppercase tracking-[0.2em] text-slate-400">Simulation Files</p>
          <div className="mt-2 max-h-[72vh] space-y-2 overflow-y-auto pr-1">
            {loading && <div className="rounded-md border border-slate-200 bg-white px-2 py-2 text-[0.76rem] text-slate-500">Loading simulation packs...</div>}
            {!loading &&
              items.map((item) => {
                const active = item.file_name === selectedFile;
                return (
                  <button
                    key={item.file_name}
                    type="button"
                    onClick={() => setSelectedFile(item.file_name)}
                    className={`w-full rounded-md border px-2 py-2 text-left transition ${
                      active ? "border-ghost-orange bg-white text-slate-900" : "border-slate-200 bg-white/80 text-slate-700 hover:border-slate-300"
                    }`}
                  >
                    <div className="truncate text-[0.73rem] font-semibold">{item.brief_summary || item.file_name}</div>
                    <div className="mt-1 text-[0.7rem] text-slate-500">{item.user}</div>
                    <div className="mt-1 truncate text-[0.66rem] text-slate-400">{item.conversation_id}</div>
                  </button>
                );
              })}
            {!loading && items.length === 0 && (
              <div className="rounded-md border border-slate-200 bg-white px-2 py-2 text-[0.76rem] text-slate-500">No simulation packs found.</div>
            )}
          </div>
        </div>

        <div className="glass rounded-xl border border-slate-200 px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Strict ElevenLabs JSON</p>
              <h3 className="mt-1 text-[0.96rem] font-semibold text-slate-900">
                {selectedMeta?.brief_summary || "Select a simulation"}
              </h3>
              <p className="text-[0.74rem] text-slate-500">{selectedMeta?.conversation_id || ""}</p>
            </div>
            <button
              type="button"
              onClick={() => void copyStrictJson()}
              disabled={!detail?.elevenlabs_test_payload_pretty}
              className="glass-button-primary rounded-md px-3 py-2 text-[0.76rem] font-semibold disabled:cursor-not-allowed disabled:opacity-60"
            >
              {copied ? "Copied" : "Copy JSON"}
            </button>
          </div>

          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-2">
            <textarea
              readOnly
              value={detail?.elevenlabs_test_payload_pretty || (busyDetail ? "Loading strict JSON..." : "")}
              className="h-[70vh] w-full resize-none bg-transparent font-mono text-[0.72rem] leading-relaxed text-slate-800 outline-none"
            />
          </div>
          <p className="mt-2 text-[0.72rem] text-slate-500">
            Paste this object directly into the ElevenLabs test JSON editor.
          </p>
        </div>
      </section>
    </div>
  );
}
