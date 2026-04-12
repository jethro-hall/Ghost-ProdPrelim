import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import IngestionHistory from "../components/IngestionHistory";
import UploadArea, { type StagedUpload } from "../components/UploadArea";
import { createCollection, deleteCollection, fetchCapabilities, fetchCollections, fetchDocuments } from "../api";
import type { AppOutletContext } from "../components/AppLayout";
import type { Collection, DocumentIngestion, RequestedLane, RuntimeCapabilities } from "../api";

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

export default function DataSourcesPage() {
  const { uploadFile, startSync, runtimeDefaults } = useOutletContext<AppOutletContext>();
  const [lane, setLane] = useState<RequestedLane>("default");
  const [status, setStatus] = useState("");
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null);
  const [documents, setDocuments] = useState<DocumentIngestion[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>("");
  const [newCollectionSlug, setNewCollectionSlug] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [collectionBusy, setCollectionBusy] = useState(false);
  const [stagedFiles, setStagedFiles] = useState<StagedUpload[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    void fetchCapabilities().then(setCapabilities).catch(() => null);
    void fetchDocuments().then(setDocuments).catch(() => null);
    void refreshCollections().catch(() => null);
  }, []);

  const cloudReady = capabilities?.parser_lanes.cloud.available ?? false;
  const stagedCount = useMemo(() => stagedFiles.filter((item) => item.status === "staged").length, [stagedFiles]);
  const selectedCollection =
    collections.find((collection) => collection.id === selectedCollectionId) ??
    collections.find((collection) => collection.slug === "default") ??
    collections[0] ??
    null;
  const runtimeDefaultCorpora = runtimeDefaults?.default_corpora ?? [];
  const primaryCollectionSlug = runtimeDefaultCorpora[0] ?? "default";
  const systemDocuments = useMemo(
    () => collections.reduce((sum, collection) => sum + (collection.impact?.documents ?? 0), 0),
    [collections],
  );
  const systemVectors = useMemo(
    () => collections.reduce((sum, collection) => sum + (collection.impact?.vector_points ?? 0), 0),
    [collections],
  );
  const runtimeAccessibleCollections = useMemo(
    () => collections.filter((collection) => runtimeDefaultCorpora.includes(collection.slug)),
    [collections, runtimeDefaultCorpora],
  );
  const runtimeAccessibleDocuments = useMemo(
    () => runtimeAccessibleCollections.reduce((sum, collection) => sum + (collection.impact?.documents ?? 0), 0),
    [runtimeAccessibleCollections],
  );
  const runtimeAccessibleVectors = useMemo(
    () => runtimeAccessibleCollections.reduce((sum, collection) => sum + (collection.impact?.vector_points ?? 0), 0),
    [runtimeAccessibleCollections],
  );
  const primaryCollection = useMemo(
    () => collections.find((collection) => collection.slug === primaryCollectionSlug) ?? null,
    [collections, primaryCollectionSlug],
  );

  async function refreshCollections() {
    const latest = await fetchCollections(true);
    setCollections(latest);
    setSelectedCollectionId((current) => {
      if (current && latest.some((collection) => collection.id === current)) {
        return current;
      }
      return latest.find((collection) => collection.slug === "default")?.id || latest[0]?.id || "";
    });
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const next = Array.from(fileList).map<StagedUpload>((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.webkitRelativePath || file.name,
      sizeLabel: formatBytes(file.size),
      lane,
      status: "staged",
    }));
    setStagedFiles((items) => [...items, ...next]);
    setStatus(`${next.length} file(s) staged for upload.`);
  }

  async function refreshDocuments() {
    const latest = await fetchDocuments();
    setDocuments(latest);
  }

  async function uploadBatch() {
    const queued = stagedFiles.filter((item) => item.status === "staged" || item.status === "error");
    if (queued.length === 0 || !selectedCollection) return;
    setUploading(true);
    setStatus(`Uploading ${queued.length} file(s) to ${selectedCollection.slug}...`);
    try {
      for (let index = 0; index < queued.length; index += 1) {
        const item = queued[index];
        setStatus(`Uploading ${index + 1} of ${queued.length} to ${selectedCollection.slug}: ${item.name}`);
        setStagedFiles((items) =>
          items.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  status: "uploading",
                  error: undefined,
                }
              : entry,
          ),
        );
        try {
          await uploadFile(item.file, selectedCollection.slug, item.lane);
          setStagedFiles((items) =>
            items.map((entry) =>
              entry.id === item.id
                ? {
                    ...entry,
                    status: "uploaded",
                    error: undefined,
                  }
                : entry,
            ),
          );
        } catch (error) {
          setStagedFiles((items) =>
            items.map((entry) =>
              entry.id === item.id
                ? {
                    ...entry,
                    status: "error",
                    error: String(error),
                  }
                : entry,
            ),
          );
        }
      }
      setStatus(`Upload complete. Starting sync for ${selectedCollection.slug}...`);
      await startSync(selectedCollection.slug);
      await refreshDocuments();
      await refreshCollections();
      setStatus(`Upload and sync complete for ${selectedCollection.slug}.`);
    } finally {
      setUploading(false);
    }
  }

  async function handleSyncSelectedCollection() {
    if (!selectedCollection) return;
    setStatus(`Starting sync for ${selectedCollection.slug}...`);
    await startSync(selectedCollection.slug);
    await refreshDocuments();
    await refreshCollections();
    setStatus(`Sync complete for ${selectedCollection.slug}.`);
  }

  async function handleCreateCollection() {
    if (!newCollectionSlug.trim()) return;
    setCollectionBusy(true);
    try {
      const created = await createCollection({
        slug: newCollectionSlug.trim(),
        name: newCollectionName.trim() || undefined,
      });
      await refreshCollections();
      setSelectedCollectionId(created.id);
      setNewCollectionSlug("");
      setNewCollectionName("");
      setStatus(`Collection ${created.slug} created.`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setCollectionBusy(false);
    }
  }

  async function handleDeleteCollection(collection: Collection) {
    const impact = collection.impact;
    const warning = [
      `Delete collection "${collection.slug}"?`,
      impact ? `${impact.documents} document(s), ${impact.vector_points} vector point(s), ${impact.agents} agent attachment(s), ${impact.conversations} conversation(s), and ${impact.cache_entries} cache entry(s) will be removed.` : "",
      impact?.active_runs ? "Deletion is blocked while an ingestion run is active." : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (impact?.active_runs) {
      window.alert(warning);
      return;
    }
    if (!window.confirm(warning)) return;
    setCollectionBusy(true);
    try {
      await deleteCollection(collection.id);
      await refreshCollections();
      await refreshDocuments();
      setStatus(`Collection ${collection.slug} deleted from metadata, vectors, files, and runtime references.`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setCollectionBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5 text-[0.8rem] text-slate-500">
        The designer handover splits ingestion from the knowledge overview. This page is now the dedicated home for staged uploads, mixed-lane batching, and document-level ingestion status.
        {stagedCount > 0 && <span className="ml-2 font-semibold text-slate-900">{stagedCount} file(s) ready.</span>}
      </section>
      <section className="grid gap-3 md:grid-cols-3">
        <div className="glass rounded-xl border border-slate-200 p-4">
          <div className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-400">System Total</div>
          <div className="mt-1 text-[1.35rem] font-bold text-slate-900">{systemDocuments}</div>
          <div className="text-[0.74rem] text-slate-500">Files across all managed collections</div>
          <div className="mt-1 text-[0.72rem] text-slate-500">{systemVectors.toLocaleString()} vector point(s)</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-4">
          <div className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-400">Runtime Default Access</div>
          <div className="mt-1 text-[1.35rem] font-bold text-slate-900">{runtimeAccessibleDocuments}</div>
          <div className="text-[0.74rem] text-slate-500">Files exposed through attached default collections</div>
          <div className="mt-1 text-[0.72rem] text-slate-500">{runtimeAccessibleVectors.toLocaleString()} vector point(s)</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-4">
          <div className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-400">Primary Collection</div>
          <div className="mt-1 text-[1.35rem] font-bold text-slate-900">{primaryCollection?.impact?.documents ?? 0}</div>
          <div className="text-[0.74rem] text-slate-500">{primaryCollection?.slug ?? primaryCollectionSlug}</div>
          <div className="mt-1 text-[0.72rem] text-slate-500">{(primaryCollection?.impact?.vector_points ?? 0).toLocaleString()} vector point(s)</div>
        </div>
      </section>
      <section className="glass rounded-xl border border-slate-200 p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[0.85rem] font-semibold text-slate-900">Managed collections</div>
            <div className="mt-1 text-[0.76rem] text-slate-500">
              Collections are now explicit namespaces. Deletion removes files, vectors, metadata, and agent/runtime bindings in one controlled sweep.
            </div>
            <div className="mt-1 text-[0.76rem] text-slate-500">
              Counts below are per selected collection only. Aggregate system totals are shown separately above.
            </div>
          </div>
          <button type="button" className="ghost-btn" onClick={() => void refreshCollections()}>
            Refresh
          </button>
        </div>
        <div className="grid gap-3 md:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-3">
            <label className="block text-[0.76rem] text-slate-500">
              Upload target collection
              <select
                className="ghost-select mt-1"
                value={selectedCollection?.id ?? ""}
                onChange={(event) => setSelectedCollectionId(event.target.value)}
              >
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name} ({collection.slug})
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-[0.76rem] text-slate-500">
                New collection slug
                <input className="ghost-input mt-1" value={newCollectionSlug} onChange={(event) => setNewCollectionSlug(event.target.value)} placeholder="finance-fy26" />
              </label>
              <label className="block text-[0.76rem] text-slate-500">
                Display name
                <input className="ghost-input mt-1" value={newCollectionName} onChange={(event) => setNewCollectionName(event.target.value)} placeholder="Finance FY26" />
              </label>
            </div>
            <button type="button" className="ghost-btn-primary" disabled={collectionBusy || !newCollectionSlug.trim()} onClick={() => void handleCreateCollection()}>
              Create collection
            </button>
            <button type="button" className="ghost-btn" disabled={collectionBusy || !selectedCollection} onClick={() => void handleSyncSelectedCollection()}>
              Sync selected collection
            </button>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.76rem] text-slate-500">
            <div className="font-semibold text-slate-900">Selected impact summary</div>
            {selectedCollection ? (
              <>
                <div className="mt-2">
                  {selectedCollection.name} (<span className="font-mono text-slate-900">{selectedCollection.slug}</span>)
                </div>
                <div className="mt-1">
                  {(selectedCollection.impact?.documents ?? 0)} file(s), {(selectedCollection.impact?.vector_points ?? 0)} vector point(s), {(selectedCollection.impact?.agents ?? 0)} attached agent(s)
                </div>
                <div className="mt-1">
                  {(selectedCollection.impact?.conversations ?? 0)} conversation(s), {(selectedCollection.impact?.cache_entries ?? 0)} cache entry(s), {(selectedCollection.impact?.ingestion_runs ?? 0)} sync run(s)
                </div>
              </>
            ) : (
              <div className="mt-2">No collections are registered yet.</div>
            )}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {collections.map((collection) => (
            <div key={collection.id} className={`rounded-xl border p-4 ${selectedCollection?.id === collection.id ? "border-orange-300 bg-orange-50/50" : "border-slate-200 bg-white/80"}`}>
              <div className="flex items-start justify-between gap-3">
                <button type="button" className="text-left" onClick={() => setSelectedCollectionId(collection.id)}>
                  <div className="text-[0.82rem] font-semibold text-slate-900">{collection.name}</div>
                  <div className="mt-1 text-[0.72rem] text-slate-500">{collection.slug}</div>
                </button>
                <button type="button" className="ghost-btn" disabled={collectionBusy} onClick={() => void handleDeleteCollection(collection)}>
                  Delete
                </button>
              </div>
              <div className="mt-3 text-[0.72rem] text-slate-500">
                {(collection.impact?.documents ?? 0)} file(s) | {(collection.impact?.retrieval_artifacts ?? 0)} retrieval artifact(s) | {(collection.impact?.vector_points ?? 0)} vector point(s)
              </div>
              <div className="mt-1 text-[0.72rem] text-slate-500">
                {(collection.impact?.agents ?? 0)} agent(s) | {(collection.impact?.conversations ?? 0)} conversation(s) | {(collection.impact?.active_runs ?? 0)} active run(s)
              </div>
            </div>
          ))}
          {collections.length === 0 && (
            <div className="rounded-xl border border-slate-200 bg-white/80 p-4 text-[0.78rem] text-slate-500">
              Create the first collection before uploading files or attaching knowledge to agents.
            </div>
          )}
        </div>
      </section>
      <UploadArea
        stagedFiles={stagedFiles}
        selectedLane={lane}
        collectionLabel={selectedCollection?.slug ?? "No collection selected"}
        cloudReady={cloudReady}
        uploading={uploading}
        statusText={status}
        onLaneChange={setLane}
        onAddFiles={addFiles}
        onRemove={(id) => setStagedFiles((items) => items.filter((item) => item.id !== id))}
        onUploadAll={() => void uploadBatch()}
        onClearCompleted={() => setStagedFiles((items) => items.filter((item) => item.status !== "uploaded"))}
      />
      <IngestionHistory history={documents} onRefresh={() => void refreshDocuments()} />
    </div>
  );
}
