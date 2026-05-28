import { useMemo, useState } from "react";

type SmartJsonMode = "text" | "tree" | "table";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortValuePreview(value: unknown, maxLen: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (isPlainObject(value)) return `Object(${Object.keys(value).length})`;
  try {
    const json = JSON.stringify(value);
    return json.length > maxLen ? `${json.slice(0, maxLen)}…` : json;
  } catch {
    return String(value);
  }
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (e) {
    return String(e);
  }
}

function JsonValue({
  value,
  depth,
  maxDepth,
}: {
  value: unknown;
  depth: number;
  maxDepth: number;
}) {
  const maxChildrenDepthReached = depth >= maxDepth;

  if (maxChildrenDepthReached) {
    return <span className="text-slate-400">{shortValuePreview(value, 120)}</span>;
  }

  if (value === null) return <span className="text-slate-300">null</span>;
  if (typeof value === "string") return <span className="text-amber-200">"{value}"</span>;
  if (typeof value === "number") return <span className="text-emerald-200">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-indigo-200">{String(value)}</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-300">[]</span>;
    return (
      <div className="ml-3 border-l border-slate-800 pl-3">
        {value.slice(0, 50).map((item, idx) => (
          <div key={`${idx}`} className="flex items-start gap-2 py-0.5">
            <span className="w-[36px] shrink-0 text-[0.68rem] text-slate-500">[{idx}]</span>
            <JsonValue value={item} depth={depth + 1} maxDepth={maxDepth} />
          </div>
        ))}
        {value.length > 50 && (
          <div className="py-1 text-[0.68rem] text-slate-500">… ({value.length - 50} more)</div>
        )}
      </div>
    );
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="text-slate-300">{"{}"}</span>;
    return (
      <div className="ml-3 border-l border-slate-800 pl-3">
        {entries.slice(0, 200).map(([k, v]) => (
          <div key={k} className="flex items-start gap-2 py-0.5">
            <span className="w-[220px] shrink-0 truncate text-[0.68rem] font-mono text-slate-500">{k}</span>
            <JsonValue value={v} depth={depth + 1} maxDepth={maxDepth} />
          </div>
        ))}
        {entries.length > 200 && (
          <div className="py-1 text-[0.68rem] text-slate-500">… ({entries.length - 200} more)</div>
        )}
      </div>
    );
  }

  return <span className="text-slate-300">{shortValuePreview(value, 240)}</span>;
}

export default function SmartJson({
  value,
  defaultMode = "tree",
  maxTextChars = 120000,
}: {
  value: unknown;
  defaultMode?: SmartJsonMode;
  maxTextChars?: number;
}) {
  const [mode, setMode] = useState<SmartJsonMode>(defaultMode);

  const text = useMemo(() => {
    const raw = safeJsonStringify(value);
    if (raw.length <= maxTextChars) return raw;
    return raw.slice(0, maxTextChars) + "\n\n[truncated]";
  }, [value, maxTextChars]);

  return (
    <div className="ghost-scroll max-h-[62vh] overflow-auto rounded-lg border border-slate-200 bg-slate-950">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
        <div className="text-[0.68rem] font-semibold text-slate-200">JSON viewer</div>
        <div className="flex items-center gap-1">
          {(["text", "tree", "table"] as SmartJsonMode[]).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md px-2 py-1 text-[0.68rem] font-semibold ${
                  active ? "bg-slate-100 text-slate-900" : "bg-slate-900 text-slate-300 hover:bg-slate-800"
                }`}
              >
                {m}
              </button>
            );
          })}
        </div>
      </div>

      {mode === "text" && <pre className="p-3 text-[0.68rem] leading-relaxed text-slate-100">{text}</pre>}

      {mode === "table" && (() => {
    const rows: Array<{ key: string; value: unknown }> = [];

    if (Array.isArray(value)) {
      value.forEach((v, idx) => {
        if (idx >= 200) return;
        rows.push({ key: String(idx), value: v });
      });
    } else if (isPlainObject(value)) {
      Object.entries(value).forEach(([k, v]) => {
        if (rows.length >= 200) return;
        rows.push({ key: k, value: v });
      });
    } else {
      rows.push({ key: "(value)", value });
    }

    return (
      <div className="px-3 pb-3 pt-3">
        {Array.isArray(value) ? (
          <div className="mb-2 text-[0.68rem] text-slate-500">Array rows (truncated at 200)</div>
        ) : isPlainObject(value) ? (
          <div className="mb-2 text-[0.68rem] text-slate-500">Object keys (truncated at 200)</div>
        ) : (
          <div className="mb-2 text-[0.68rem] text-slate-500">Single value</div>
        )}

        <table className="w-full border-collapse text-[0.68rem]">
          <thead>
            <tr className="bg-slate-900 text-slate-200">
              <th className="px-3 py-2 text-left font-semibold">Key</th>
              <th className="px-3 py-2 text-left font-semibold">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-slate-800 text-slate-100">
                <td className="px-3 py-2 align-top font-mono text-slate-200">{row.key}</td>
                <td className="px-3 py-2 align-top">
                  <span className={typeof row.value === "object" ? "text-slate-400" : ""}>
                    {shortValuePreview(row.value, 400)}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr className="border-t border-slate-800">
                <td className="px-3 py-2 text-slate-500" colSpan={2}>
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
      })()}

      {mode === "tree" && <div className="p-3"><JsonValue value={value} depth={0} maxDepth={10} /></div>}
    </div>
  );
}

