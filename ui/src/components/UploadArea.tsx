import { useEffect, useRef } from "react";
import { TrashIcon, UploadIcon } from "./ReferenceIcons";
import { formatRequestedLane, type RequestedLane } from "../api";

export type StagedUpload = {
  id: string;
  file: File;
  name: string;
  sizeLabel: string;
  lane: RequestedLane;
  status: "staged" | "uploading" | "uploaded" | "error";
  error?: string;
};

type Props = {
  stagedFiles: StagedUpload[];
  selectedLane: RequestedLane;
  collectionLabel: string;
  cloudReady: boolean;
  uploading: boolean;
  statusText: string;
  onLaneChange: (lane: RequestedLane) => void;
  onAddFiles: (files: FileList | null) => void;
  onRemove: (id: string) => void;
  onUploadAll: () => void;
  onClearCompleted: () => void;
};

function rowStatusLabel(item: StagedUpload) {
  if (item.status === "uploading") return "Uploading";
  if (item.status === "uploaded") return "Uploaded";
  if (item.status === "error") return "Error";
  return "Queued";
}

function rowStatusClass(item: StagedUpload) {
  if (item.status === "uploaded") return "text-emerald-600";
  if (item.status === "error") return "text-rose-600";
  if (item.status === "uploading") return "text-amber-600";
  return "text-slate-500";
}

export default function UploadArea({
  stagedFiles,
  selectedLane,
  collectionLabel,
  cloudReady,
  uploading,
  statusText,
  onLaneChange,
  onAddFiles,
  onRemove,
  onUploadAll,
  onClearCompleted,
}: Props) {
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!folderInputRef.current) return;
    folderInputRef.current.setAttribute("webkitdirectory", "");
    folderInputRef.current.setAttribute("directory", "");
    folderInputRef.current.setAttribute("multiple", "");
  }, []);

  return (
    <div className="mb-6 max-w-[700px]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[0.9rem] font-semibold text-slate-900">Dashboard Upload</h3>
          <div className="mt-1 text-[0.72rem] text-slate-500">Target collection: {collectionLabel}</div>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="ghost-select w-[185px] text-[0.75rem]"
            value={selectedLane}
            onChange={(event) => onLaneChange(event.target.value as RequestedLane)}
          >
            <option value="default">Default (runtime policy)</option>
            <option value="local">Local only</option>
            <option value="cloud" disabled={!cloudReady}>
              Cloud only (LlamaParse){!cloudReady ? " - unavailable" : ""}
            </option>
          </select>
          <button type="button" className="ghost-btn-primary" onClick={onUploadAll} disabled={uploading || stagedFiles.length === 0}>
            <UploadIcon size={14} />
            {uploading ? "Uploading..." : stagedFiles.length > 0 ? `Upload ${stagedFiles.length} file${stagedFiles.length === 1 ? "" : "s"}` : "Upload batch"}
          </button>
        </div>
      </div>

      <div
        className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-slate-300 bg-white/60 p-8 text-center transition-all duration-200 hover:border-ghost-orange hover:bg-orange-50/40"
        onClick={() => filesInputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          onAddFiles(event.dataTransfer.files);
        }}
      >
        <UploadIcon size={32} strokeWidth={1.5} className="text-slate-400" />
        <p className="text-[0.8rem] text-slate-500">
          Drag and drop files and folders here, or choose <strong className="font-semibold text-slate-900">Add files</strong>, or <strong className="font-semibold text-slate-900">Add folders</strong>.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className="ghost-btn"
            onClick={(event) => {
              event.stopPropagation();
              filesInputRef.current?.click();
            }}
          >
            Add files
          </button>
          <button
            type="button"
            className="ghost-btn"
            onClick={(event) => {
              event.stopPropagation();
              folderInputRef.current?.click();
            }}
          >
            Add folders
          </button>
        </div>
        <input
          ref={filesInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            onAddFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          className="hidden"
          onChange={(event) => {
            onAddFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {!cloudReady && (
        <p className="mt-2 text-[0.72rem] text-amber-700">
          Cloud parsing is currently blocked because `LLAMA_CLOUD_API_KEY` is not configured in the live environment.
        </p>
      )}
      <p className="mt-2 text-[0.72rem] text-slate-500">
        `Default` leaves PDF lane choice to the active runtime policy. `Local` and `Cloud` are explicit overrides.
      </p>

      {statusText && <p className="mt-2 text-[0.75rem] text-slate-500">{statusText}</p>}

      {stagedFiles.length > 0 && (
        <div className="mt-2.5 overflow-hidden rounded-md border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[0.65rem] font-bold uppercase tracking-[0.18em] text-slate-500">Staged files</div>
            <button type="button" className="ghost-btn" onClick={onClearCompleted}>
              Clear completed
            </button>
          </div>
          <table className="w-full border-collapse text-[0.8rem]">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-[0.65rem] font-bold uppercase tracking-[0.14em] text-slate-500">
                <th className="px-2.5 py-2">Name</th>
                <th className="px-2.5 py-2">Requested lane</th>
                <th className="px-2.5 py-2">Status</th>
                <th className="px-2.5 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {stagedFiles.map((file) => (
                <tr key={file.id} className="border-b border-slate-100 text-slate-900 last:border-b-0">
                  <td className="px-2.5 py-2">
                    <div className="max-w-[320px] truncate font-medium">{file.name}</div>
                    <div className="text-[0.72rem] text-slate-500">{file.sizeLabel}</div>
                    {file.error && <div className="mt-0.5 text-[0.72rem] text-rose-600">{file.error}</div>}
                  </td>
                  <td className="px-2.5 py-2 text-slate-600">{formatRequestedLane(file.lane)}</td>
                  <td className={`px-2.5 py-2 font-medium ${rowStatusClass(file)}`}>{rowStatusLabel(file)}</td>
                  <td className="px-2.5 py-2">
                    <button
                      type="button"
                      onClick={() => onRemove(file.id)}
                      disabled={file.status === "uploading"}
                      className="text-slate-500 transition-colors duration-150 hover:text-rose-600"
                    >
                      <TrashIcon size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
