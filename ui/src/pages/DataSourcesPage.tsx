import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import IngestionHistory from "../components/IngestionHistory";
import UploadArea, { type StagedUpload } from "../components/UploadArea";
import { fetchCapabilities, fetchDocuments } from "../api";
import type { AppOutletContext } from "../components/AppLayout";
import type { DocumentIngestion, RuntimeCapabilities } from "../api";

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
  const { uploadFile } = useOutletContext<AppOutletContext>();
  const [lane, setLane] = useState<"local" | "cloud">("local");
  const [status, setStatus] = useState("");
  const [capabilities, setCapabilities] = useState<RuntimeCapabilities | null>(null);
  const [documents, setDocuments] = useState<DocumentIngestion[]>([]);
  const [stagedFiles, setStagedFiles] = useState<StagedUpload[]>([]);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    void fetchCapabilities().then(setCapabilities).catch(() => null);
    void fetchDocuments().then(setDocuments).catch(() => null);
  }, []);

  const cloudReady = capabilities?.parser_lanes.cloud.available ?? false;
  const stagedCount = useMemo(() => stagedFiles.filter((item) => item.status === "staged").length, [stagedFiles]);

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
    if (queued.length === 0) return;
    setUploading(true);
    setStatus(`Uploading ${queued.length} file(s)...`);
    try {
      for (let index = 0; index < queued.length; index += 1) {
        const item = queued[index];
        setStatus(`Uploading ${index + 1} of ${queued.length}: ${item.name}`);
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
          await uploadFile(item.file, "default", item.lane);
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
      await refreshDocuments();
      setStatus("Batch upload complete.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="glass rounded-xl border border-slate-200 p-5 text-[0.8rem] text-slate-500">
        The designer handover splits ingestion from the knowledge overview. This page is now the dedicated home for staged uploads, mixed-lane batching, and document-level ingestion status.
        {stagedCount > 0 && <span className="ml-2 font-semibold text-slate-900">{stagedCount} file(s) ready.</span>}
      </section>
      <UploadArea
        stagedFiles={stagedFiles}
        selectedLane={lane}
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
