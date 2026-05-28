import { useEffect, useMemo, useRef, useState } from "react";
import WebViewer from "@pdftron/webviewer";
import type { ChatDocxMode, DocxArtifact, DocxDiagnostic } from "../../types/docx";

type Props = {
  docxMode: ChatDocxMode;
  onDocxModeChange: (next: ChatDocxMode) => void;
  artifacts?: DocxArtifact[];
  diagnostics?: DocxDiagnostic[];
};

export default function ApryseDocumentPanel({
  docxMode,
  onDocxModeChange,
  artifacts = [],
  diagnostics = [],
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const webviewerKey = import.meta.env.VITE_APRYSE_LICENSE_KEY as string | undefined;

  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.kind === "docx" || artifact.kind === "pdf" || artifact.kind === "html") ?? null,
    [artifacts],
  );
  const operationLabel = docxMode.operation === "finalize" ? "Finalize" : "Preview";

  useEffect(() => {
    if (!docxMode.enabled) return;
    if (!hostRef.current || viewerRef.current) return;
    if (!webviewerKey?.trim()) {
      setBootError("Apryse key is missing. Set VITE_APRYSE_LICENSE_KEY to enable document preview.");
      return;
    }

    let cancelled = false;
    void WebViewer(
      {
        path: "/lib/webviewer",
        licenseKey: webviewerKey,
      },
      hostRef.current,
    )
      .then((instance) => {
        if (cancelled) return;
        viewerRef.current = instance;
        setBootError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBootError(`Apryse failed to initialize: ${String(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [docxMode.enabled, webviewerKey]);

  useEffect(() => {
    if (!viewerRef.current || !selectedArtifact?.uri) return;
    void viewerRef.current.UI.loadDocument(selectedArtifact.uri);
  }, [selectedArtifact]);

  if (!docxMode.enabled) {
    return null;
  }

  return (
    <section className="flex h-full min-h-[300px] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-[0.72rem]">
        <span className="font-semibold uppercase tracking-[0.14em] text-slate-500">Apryse Docs</span>
        <select
          className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-slate-700"
          value={docxMode.operation}
          onChange={(event) =>
            onDocxModeChange({
              ...docxMode,
              operation: event.target.value as ChatDocxMode["operation"],
            })
          }
        >
          <option value="preview">Preview</option>
          <option value="finalize">Finalize</option>
        </select>
        <input
          className="min-w-[220px] flex-1 rounded-md border border-slate-200 px-2 py-1 text-slate-700"
          value={docxMode.templateId}
          onChange={(event) =>
            onDocxModeChange({
              ...docxMode,
              templateId: event.target.value,
            })
          }
          placeholder="Template ID"
        />
        <span className="text-[0.68rem] text-slate-600">
          Template ID identifies the doc template to render. Chat remains active while {operationLabel.toLowerCase()} runs.
        </span>
      </div>
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-[0.68rem] text-slate-700">
        Use <span className="font-semibold">Preview</span> for draft artifacts and{" "}
        <span className="font-semibold">Finalize</span> for final output. If finalize fails, diagnostics will explain exactly why.
      </div>
      {docxMode.operation === "finalize" && !docxMode.templateId.trim() && (
        <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-[0.68rem] text-amber-800">
          Finalize needs a template ID. Enter one before sending your next chat request.
        </div>
      )}
      {bootError ? (
        <div className="p-3 text-xs text-rose-700">{bootError}</div>
      ) : (
        <div ref={hostRef} className="min-h-[260px] flex-1" />
      )}
      {artifacts.length > 0 && (
        <div className="border-t border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
          <div className="mb-1 font-semibold text-slate-800">Generated artifacts</div>
          <div className="flex flex-wrap gap-2">
            {artifacts.map((artifact) => (
              <a
                key={`${artifact.kind}-${artifact.uri}`}
                href={artifact.uri}
                target="_blank"
                rel="noreferrer"
                className={`rounded-md border px-2 py-1 ${
                  selectedArtifact?.uri === artifact.uri
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-slate-50 text-slate-700"
                }`}
                title={artifact.uri}
              >
                {artifact.label || `${artifact.kind.toUpperCase()} artifact`}
              </a>
            ))}
          </div>
        </div>
      )}
      {diagnostics.length > 0 && (
        <div className="border-t border-slate-200 bg-amber-50 px-3 py-2 text-xs text-slate-800">
          <div className="mb-1 font-semibold">Diagnostics</div>
          {diagnostics.map((diagnostic) => (
            <div key={`${diagnostic.code}-${diagnostic.message}`}>
              [{diagnostic.code}] {diagnostic.message}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
