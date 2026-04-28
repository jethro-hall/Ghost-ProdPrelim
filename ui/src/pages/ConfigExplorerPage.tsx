import { useEffect, useMemo, useState } from "react";
import {
  fetchConfigExplorer,
  fetchRuntimeProfilePolicyAudits,
  patchConfigExplorer,
  rollbackConfigExplorerAudit,
  type ConfigExplorerEditRequest,
  type ConfigExplorerEntry,
  type PolicyChangeAuditView,
  type RuntimeProfileGuardrailsConfig,
} from "../api";
import GuardrailsConfigEditor from "../components/GuardrailsConfigEditor";
import SmartJson from "../components/SmartJson";
import { guardrailsConfigToValueJson, normalizeGuardrailsFromValueJson } from "../lib/guardrailsNormalize";

const NAMESPACES = ["all", "guardrails", "llm", "kb", "retrieval", "tool_policy"] as const;

type GuardrailsSectionProps = {
  entry: ConfigExplorerEntry;
  audits: PolicyChangeAuditView[];
  auditsLoading: boolean;
  onReloadList: () => Promise<void>;
};

function ConfigExplorerGuardrailsSection({ entry, audits, auditsLoading, onReloadList }: GuardrailsSectionProps) {
  const [guardrailsDraft, setGuardrailsDraft] = useState<RuntimeProfileGuardrailsConfig>(() =>
    normalizeGuardrailsFromValueJson(entry.value_json),
  );
  const [useRawJson, setUseRawJson] = useState(false);
  const [rawJsonText, setRawJsonText] = useState(() =>
    JSON.stringify(guardrailsConfigToValueJson(normalizeGuardrailsFromValueJson(entry.value_json)), null, 2),
  );
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [policyActor, setPolicyActor] = useState("operator");
  const [policyApprovalToken, setPolicyApprovalToken] = useState<string>("");
  const [policyApprovalReason, setPolicyApprovalReason] = useState<string>("");

  useEffect(() => {
    const normalized = normalizeGuardrailsFromValueJson(entry.value_json);
    setGuardrailsDraft(normalized);
    setUseRawJson(false);
    setRawJsonText(JSON.stringify(guardrailsConfigToValueJson(normalized), null, 2));
    setEditError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resync when the row version changes; `value_json` is read from `entry` at that time.
  }, [entry.key, entry.updated_at]);

  function applyRawJsonToDraft(): boolean {
    try {
      const parsed = JSON.parse(rawJsonText || "{}") as unknown;
      setGuardrailsDraft(normalizeGuardrailsFromValueJson(parsed));
      setEditError(null);
      return true;
    } catch (e) {
      setEditError(`Invalid JSON: ${String(e)}`);
      return false;
    }
  }

  function switchToStructuredEditor() {
    if (!applyRawJsonToDraft()) return;
    setUseRawJson(false);
  }

  function switchToRawJsonEditor() {
    setRawJsonText(JSON.stringify(guardrailsConfigToValueJson(guardrailsDraft), null, 2));
    setUseRawJson(true);
    setEditError(null);
  }

  async function onSaveGuardrails() {
    let parsed: Record<string, unknown>;
    if (useRawJson) {
      try {
        parsed = JSON.parse(rawJsonText || "{}") as Record<string, unknown>;
      } catch (e) {
        setEditError(`Invalid JSON: ${String(e)}`);
        return;
      }
    } else {
      parsed = guardrailsConfigToValueJson(guardrailsDraft);
    }

    setEditSaving(true);
    setEditError(null);
    try {
      const body: ConfigExplorerEditRequest = {
        expected_updated_at: entry.updated_at,
        value_json: parsed,
        policy_actor: policyActor,
        policy_approval_token: policyApprovalToken?.trim() || null,
        policy_approval_reason: policyApprovalReason?.trim() || null,
      };
      await patchConfigExplorer(entry.key, body);
      await onReloadList();
    } catch (err) {
      setEditError(String(err));
    } finally {
      setEditSaving(false);
    }
  }

  async function onRollbackLatestAudit() {
    const latest = audits[0];
    if (!latest) return;

    setEditSaving(true);
    setEditError(null);
    try {
      await rollbackConfigExplorerAudit(latest.id, {
        policy_actor: policyActor,
        policy_approval_token: policyApprovalToken?.trim() || null,
        policy_approval_reason: policyApprovalReason?.trim() || null,
      });
      await onReloadList();
    } catch (err) {
      setEditError(String(err));
    } finally {
      setEditSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-ghost-orange/50 bg-ghost-orange/5 p-3">
        <div className="text-[0.72rem] font-semibold text-ghost-orange">Phase-2: Safe edit (guardrails only)</div>
        <div className="mt-1 text-[0.68rem] text-slate-600">
          Use the structured fields (with Markdown preview) or switch to raw JSON. Backend validates against the `RuntimeProfileGuardrailsConfig` schema and requires an exact `updated_at` match to prevent drift.
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-[1fr_1fr]">
        <label className="space-y-1">
          <div className="text-[0.65rem] font-semibold text-slate-600">Policy actor</div>
          <input className="ghost-input bg-white" value={policyActor} onChange={(e) => setPolicyActor(e.target.value)} />
        </label>
        <label className="space-y-1">
          <div className="text-[0.65rem] font-semibold text-slate-600">Approval token (optional)</div>
          <input
            className="ghost-input bg-white"
            value={policyApprovalToken}
            onChange={(e) => setPolicyApprovalToken(e.target.value)}
            placeholder="Paste admin approval token if required"
          />
        </label>
      </div>

      <label className="space-y-1">
        <div className="text-[0.65rem] font-semibold text-slate-600">Approval reason (optional)</div>
        <input
          className="ghost-input bg-white"
          value={policyApprovalReason}
          onChange={(e) => setPolicyApprovalReason(e.target.value)}
          placeholder="Human-readable reason for traceability"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => (useRawJson ? switchToStructuredEditor() : switchToRawJsonEditor())}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[0.72rem] font-semibold text-slate-700 hover:bg-slate-50"
        >
          {useRawJson ? "Structured editor" : "Raw JSON"}
        </button>
        {useRawJson ? (
          <span className="text-[0.65rem] text-slate-500">
            Editing JSON text; invalid JSON will fail on Save or when returning to structured mode.
          </span>
        ) : (
          <span className="text-[0.65rem] text-slate-500">Long text uses real line breaks; preview renders Markdown.</span>
        )}
      </div>

      {!useRawJson ? (
        <div className="ghost-scroll max-h-[min(70vh,1200px)] overflow-y-auto pr-1">
          <GuardrailsConfigEditor value={guardrailsDraft} onChange={setGuardrailsDraft} />
        </div>
      ) : (
        <textarea
          className="ghost-input bg-slate-950 text-slate-100 ghost-scroll min-h-[28vh] rounded-lg border border-slate-200 p-3 font-mono text-[0.68rem] leading-relaxed"
          value={rawJsonText}
          onChange={(e) => {
            setRawJsonText(e.target.value);
            setEditError(null);
          }}
          spellCheck={false}
        />
      )}

      {editError && <p className="text-[0.72rem] text-rose-600">{editError}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void onSaveGuardrails()}
          disabled={editSaving || auditsLoading}
          className="rounded-md bg-ghost-orange/10 px-3 py-1.5 text-[0.72rem] font-semibold text-ghost-orange hover:bg-ghost-orange/20 disabled:opacity-60"
        >
          {editSaving ? "Saving..." : "Save guardrails"}
        </button>
        <button
          type="button"
          onClick={() => void onRollbackLatestAudit()}
          disabled={editSaving || auditsLoading || audits.length === 0}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[0.72rem] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          title={
            audits.length === 0
              ? "No recent audit entries available."
              : "Rollback using the latest runtime policy audit record (before_json)."
          }
        >
          Rollback latest
        </button>
        {auditsLoading && <span className="text-[0.68rem] text-slate-500">Loading audit history...</span>}
      </div>

      {audits.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-[0.72rem] font-semibold text-slate-900">Latest policy audit</div>
          <div className="mt-1 text-[0.68rem] text-slate-600">
            {audits[0].actor} • {audits[0].action} • {audits[0].status} • {audits[0].created_at}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ConfigExplorerPage() {
  const [entries, setEntries] = useState<ConfigExplorerEntry[]>([]);
  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState<(typeof NAMESPACES)[number]>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [audits, setAudits] = useState<PolicyChangeAuditView[]>([]);
  const [auditsLoading, setAuditsLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchConfigExplorer({
        q: query.trim() || undefined,
        namespace: namespace === "all" ? undefined : namespace,
      });
      setEntries(data);
      if (!selectedKey && data.length > 0) {
        setSelectedKey(data[0].key);
      }
      if (selectedKey && !data.some((item) => item.key === selectedKey)) {
        setSelectedKey(data[0]?.key ?? null);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selected = useMemo(
    () => entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null,
    [entries, selectedKey],
  );

  const selectedRuntimeProfileId = useMemo(() => {
    if (!selected?.key) return null;
    const parts = selected.key.split(".");
    if (parts.length < 3 || parts[0] !== "runtime_profile") return null;
    return parts[1] ?? null;
  }, [selected]);

  useEffect(() => {
    setAudits([]);
    if (!selected || selected.namespace !== "guardrails" || !selectedRuntimeProfileId) {
      return;
    }
    setAuditsLoading(true);
    void fetchRuntimeProfilePolicyAudits(selectedRuntimeProfileId, 10)
      .then((rows) => setAudits(rows))
      .catch((err) => setError(String(err)))
      .finally(() => setAuditsLoading(false));
  }, [selected?.key, selected?.namespace, selectedRuntimeProfileId]);

  return (
    <section className="space-y-4">
      <div className="glass rounded-xl border border-slate-200 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-[1rem] font-semibold text-slate-900">Config Explorer</h2>
            <p className="text-[0.74rem] text-slate-500">
              Search and inspect runtime JSON loaded in GhostDASH. Guardrails keys support structured edit, Markdown preview, and raw
              JSON.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[0.72rem] font-semibold text-slate-700 hover:bg-slate-50"
            disabled={loading}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        <div className="grid gap-2 md:grid-cols-[1fr_180px_auto]">
          <input
            className="ghost-input bg-white"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search key, source, or JSON content"
          />
          <select
            className="ghost-input bg-white"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value as (typeof NAMESPACES)[number])}
          >
            {NAMESPACES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-ghost-orange/50 bg-ghost-orange/10 px-3 py-1.5 text-[0.72rem] font-semibold text-ghost-orange hover:bg-ghost-orange/20"
          >
            Search
          </button>
        </div>
        {error && <p className="mt-2 text-[0.72rem] text-rose-600">{error}</p>}
      </div>

      <div className="grid gap-3 lg:grid-cols-[340px_1fr]">
        <div className="glass rounded-xl border border-slate-200 p-3">
          <div className="mb-2 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-slate-500">
            Config Keys ({entries.length})
          </div>
          <div className="ghost-scroll max-h-[62vh] space-y-1 overflow-auto pr-1">
            {entries.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setSelectedKey(entry.key)}
                className={`w-full rounded-md border px-2 py-1.5 text-left text-[0.7rem] ${
                  selected?.key === entry.key
                    ? "border-ghost-orange/40 bg-ghost-orange/10 text-slate-900"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <div className="truncate font-semibold">{entry.key}</div>
                <div className="mt-0.5 flex items-center gap-1 text-[0.62rem] text-slate-500">
                  <span>{entry.source_name}</span>
                  <span>•</span>
                  <span>{entry.namespace}</span>
                </div>
              </button>
            ))}
            {entries.length === 0 && <div className="text-[0.72rem] text-slate-500">No matching config entries.</div>}
          </div>
        </div>

        <div className="glass rounded-xl border border-slate-200 p-3">
          {selected ? (
            <>
              <div className="mb-2 space-y-1">
                <h3 className="text-[0.9rem] font-semibold text-slate-900">{selected.key}</h3>
                <p className="text-[0.68rem] text-slate-500">
                  {selected.source_name} • {selected.namespace} • Updated {new Date(selected.updated_at).toLocaleString()}
                </p>
              </div>

              {selected.namespace !== "guardrails" ? (
                <SmartJson value={selected.value_json} />
              ) : (
                <ConfigExplorerGuardrailsSection
                  key={selected.key}
                  entry={selected}
                  audits={audits}
                  auditsLoading={auditsLoading}
                  onReloadList={load}
                />
              )}
            </>
          ) : (
            <div className="text-[0.74rem] text-slate-500">Select a config key to inspect its JSON value.</div>
          )}
        </div>
      </div>
    </section>
  );
}
