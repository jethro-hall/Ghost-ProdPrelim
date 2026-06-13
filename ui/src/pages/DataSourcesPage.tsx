import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import IngestionHistory from "../components/IngestionHistory";
import UploadArea, { type StagedUpload } from "../components/UploadArea";
import { relativePathForFile } from "../lib/collectDroppedFiles";
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

  function addFiles(fileList: FileList | File[] | null) {
    if (!fileList || fileList.length === 0) return;
    const next = Array.from(fileList).map<StagedUpload>((file) => ({
      id: crypto.randomUUID(),
      file,
      name: relativePathForFile(file),
      sizeLabel: formatBytes(file.size),
      lane,
      status: "staged",
    }));
    const folderCount = new Set(next.map((item) => item.name.split("/")[0]).filter(Boolean)).size;
    setStagedFiles((items) => [...items, ...next]);
    setStatus(
      next.length === 1
        ? `1 file staged for upload.`
        : `${next.length} file(s) staged${folderCount > 1 ? ` from ${folderCount} top-level folder(s)` : ""}.`,
    );
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
          await uploadFile(item.file, selectedCollection.slug, item.lane, item.name);
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
    <div className="data-sources-page space-y-4">
      <section className="glass rounded-xl border border-slate-200 px-4 py-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.2em] text-slate-400">Data sources</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h2 className="text-[1rem] font-semibold text-slate-900">Upload and collection workspace</h2>
              <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
                {stagedCount} staged
              </span>
            </div>
          </div>
          <div className="data-sources-command-bar flex flex-wrap items-center gap-2">
            <button type="button" className="ghost-btn" onClick={() => void refreshCollections()}>
              Refresh
            </button>
            <button type="button" className="ghost-btn" disabled={collectionBusy || !selectedCollection} onClick={() => void handleSyncSelectedCollection()}>
              Sync selected
            </button>
          </div>
        </div>
        {status && (
          <div className="mt-2 rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-[0.74rem] text-slate-600">
            {status}
          </div>
        )}
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        <div className="glass rounded-xl border border-slate-200 p-4">
          <div className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-400">System total</div>
          <div className="mt-1 text-[1.35rem] font-bold text-slate-900">{systemDocuments}</div>
          <div className="text-[0.74rem] text-slate-500">{systemVectors.toLocaleString()} vector point(s)</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-4">
          <div className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-400">Runtime access</div>
          <div className="mt-1 text-[1.35rem] font-bold text-slate-900">{runtimeAccessibleDocuments}</div>
          <div className="text-[0.74rem] text-slate-500">{runtimeAccessibleVectors.toLocaleString()} vector point(s)</div>
        </div>
        <div className="glass rounded-xl border border-slate-200 p-4">
          <div className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-slate-400">Primary collection</div>
          <div className="mt-1 text-[1.35rem] font-bold text-slate-900">{primaryCollection?.impact?.documents ?? 0}</div>
          <div className="text-[0.74rem] text-slate-500">{primaryCollection?.slug ?? primaryCollectionSlug}</div>
        </div>
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px] 2xl:grid-cols-[minmax(0,1fr)_370px]">
        <div className="space-y-3">
          <section className="glass rounded-xl border border-slate-200 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-[0.84rem] font-semibold text-slate-900">Upload workspace</h3>
              <div className="text-[0.7rem] text-slate-500">{selectedCollection?.slug ?? "No collection selected"}</div>
            </div>
            <UploadArea
              stagedFiles={stagedFiles}
              selectedLane={lane}
              collectionLabel={selectedCollection?.slug ?? "No collection selected"}
              cloudReady={cloudReady}
              uploading={uploading}
              statusText=""
              onLaneChange={setLane}
              onAddFiles={addFiles}
              onRemove={(id) => setStagedFiles((items) => items.filter((item) => item.id !== id))}
              onUploadAll={() => void uploadBatch()}
              onClearCompleted={() => setStagedFiles((items) => items.filter((item) => item.status !== "uploaded"))}
            />
          </section>

          <section className="glass rounded-xl border border-slate-200 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-[0.84rem] font-semibold text-slate-900">Ingestion history</h3>
              <button type="button" className="ghost-btn" onClick={() => void refreshDocuments()}>
                Refresh
              </button>
            </div>
            <IngestionHistory history={documents} onRefresh={() => void refreshDocuments()} />
          </section>
        </div>

        <aside className="glass rounded-xl border border-slate-200 p-3">
          <div className="space-y-3">
            <section className="rounded-lg border border-slate-200 bg-white/80 p-2">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Collection target</div>
              <label className="block text-[0.72rem] text-slate-500">
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
            </section>

            <section className="rounded-lg border border-slate-200 bg-white/80 p-2">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Create collection</div>
              <div className="grid gap-2">
                <label className="block text-[0.72rem] text-slate-500">
                  New collection slug
                  <input className="ghost-input mt-1" value={newCollectionSlug} onChange={(event) => setNewCollectionSlug(event.target.value)} placeholder="finance-fy26" />
                </label>
                <label className="block text-[0.72rem] text-slate-500">
                  Display name
                  <input className="ghost-input mt-1" value={newCollectionName} onChange={(event) => setNewCollectionName(event.target.value)} placeholder="Finance FY26" />
                </label>
                <button type="button" className="ghost-btn-primary" disabled={collectionBusy || !newCollectionSlug.trim()} onClick={() => void handleCreateCollection()}>
                  Create collection
                </button>
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white/80 p-2 text-[0.72rem] text-slate-500">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Selected impact</div>
              {selectedCollection ? (
                <div className="space-y-1">
                  <div><span className="font-semibold text-slate-900">{selectedCollection.name}</span> ({selectedCollection.slug})</div>
                  <div>{selectedCollection.impact?.documents ?? 0} file(s) • {selectedCollection.impact?.vector_points ?? 0} vector point(s)</div>
                  <div>{selectedCollection.impact?.agents ?? 0} agent(s) • {selectedCollection.impact?.conversations ?? 0} conversation(s)</div>
                  <div>{selectedCollection.impact?.cache_entries ?? 0} cache entry(s) • {selectedCollection.impact?.ingestion_runs ?? 0} sync run(s)</div>
                </div>
              ) : (
                <div>No collections are registered yet.</div>
              )}
            </section>

            <section className="rounded-lg border border-slate-200 bg-white/80 p-2">
              <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-400">Managed collections</div>
              <div className="space-y-2">
                {collections.map((collection) => (
                  <div key={collection.id} className={`rounded-md border px-2 py-2 ${selectedCollection?.id === collection.id ? "border-orange-300 bg-orange-50/50" : "border-slate-200 bg-white"}`}>
                    <div className="flex items-start justify-between gap-2">
                      <button type="button" className="min-w-0 text-left" onClick={() => setSelectedCollectionId(collection.id)}>
                        <div className="truncate text-[0.76rem] font-semibold text-slate-900">{collection.name}</div>
                        <div className="mt-0.5 text-[0.68rem] text-slate-500">{collection.slug}</div>
                      </button>
                      <button type="button" className="ghost-btn" disabled={collectionBusy} onClick={() => void handleDeleteCollection(collection)}>
                        Delete
                      </button>
                    </div>
                    <div className="mt-2 text-[0.68rem] text-slate-500">
                      {(collection.impact?.documents ?? 0)} file(s) • {(collection.impact?.vector_points ?? 0)} vector point(s)
                    </div>
                  </div>
                ))}
                {collections.length === 0 && (
                  <div className="rounded-md border border-slate-200 bg-white px-2 py-2 text-[0.72rem] text-slate-500">
                    Create the first collection before uploading files or attaching knowledge to agents.
                  </div>
                )}
              </div>
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
