import type { ProviderKind } from "../api";

const STORAGE_KEY = "ghostdash.agentConfig.modelIds.v1";

type Store = {
  byConnectionId: Record<string, string>;
  byProviderKind: Record<string, string>;
};

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { byConnectionId: {}, byProviderKind: {} };
    }
    const parsed = JSON.parse(raw) as Partial<Store>;
    return {
      byConnectionId: typeof parsed.byConnectionId === "object" && parsed.byConnectionId ? parsed.byConnectionId : {},
      byProviderKind: typeof parsed.byProviderKind === "object" && parsed.byProviderKind ? parsed.byProviderKind : {},
    };
  } catch {
    return { byConnectionId: {}, byProviderKind: {} };
  }
}

function writeStore(store: Store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota / private mode
  }
}

const KIND_DEFAULTS: Record<ProviderKind, string> = {
  openai: "openai/llama31-8b",
  anthropic: "anthropic/claude-3-5-sonnet-20241022",
  google_gemini: "google/gemini-2.0-flash",
  openai_compatible: "openai/llama31-8b",
};

export function defaultModelIdForProviderKind(kind: ProviderKind, runtimeDefault?: string | null): string {
  const trimmed = runtimeDefault?.trim();
  if (trimmed) {
    return trimmed;
  }
  return KIND_DEFAULTS[kind] ?? KIND_DEFAULTS.openai;
}

/** Persist the last model id used with this connection and provider kind (browser localStorage). */
export function rememberModelSelection(args: { connectionId: string; providerKind: ProviderKind; modelId: string }) {
  const trimmed = args.modelId.trim();
  if (!trimmed || !args.connectionId) {
    return;
  }
  const store = readStore();
  store.byConnectionId[args.connectionId] = trimmed;
  store.byProviderKind[args.providerKind] = trimmed;
  writeStore(store);
}

/**
 * Prefer model remembered for this connection, then last model for this provider kind,
 * then runtime defaults / kind default.
 */
export function recallModelForConnection(args: {
  connectionId: string;
  providerKind: ProviderKind;
  runtimeDefaultModelId?: string | null;
}): string {
  const store = readStore();
  const byConn = store.byConnectionId[args.connectionId]?.trim();
  if (byConn) {
    return byConn;
  }
  const byKind = store.byProviderKind[args.providerKind]?.trim();
  if (byKind) {
    return byKind;
  }
  return defaultModelIdForProviderKind(args.providerKind, args.runtimeDefaultModelId);
}

/** Curated defaults shown in Agent Config quick-pick; merged with saved browser models. */
export const PRESET_MODEL_IDS_BY_KIND: Record<ProviderKind, readonly string[]> = {
  openai: [
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "openai/gpt-4-turbo",
    "openai/o3-mini",
    "openai/llama31-8b",
    "gpt-4o",
    "gpt-4o-mini",
  ],
  anthropic: [
    "anthropic/claude-3-5-sonnet-20241022",
    "anthropic/claude-3-5-haiku-20241022",
    "anthropic/claude-3-opus-20240229",
    "claude-3-5-sonnet-20241022",
  ],
  google_gemini: [
    "google/gemini-2.0-flash",
    "google/gemini-2.5-pro-preview-05-06",
    "gemini-2.0-flash",
    "gemini-2.5-pro-preview-05-06",
    "gemini-3.1-pro-preview",
  ],
  openai_compatible: [
    "openai/llama31-8b",
    "gpt-4o-mini",
    "gpt-4o",
  ],
};

function collectRememberedModelIds(): string[] {
  const store = readStore();
  const out = new Set<string>();
  for (const v of Object.values(store.byConnectionId)) {
    const t = v?.trim();
    if (t) {
      out.add(t);
    }
  }
  for (const v of Object.values(store.byProviderKind)) {
    const t = v?.trim();
    if (t) {
      out.add(t);
    }
  }
  return [...out];
}

/** All curated presets across provider kinds (operator may route any model id through any connection). */
export function getAllPresetModelIds(): string[] {
  const merged = new Set<string>();
  for (const list of Object.values(PRESET_MODEL_IDS_BY_KIND)) {
    for (const id of list) {
      const t = id.trim();
      if (t) {
        merged.add(t);
      }
    }
  }
  return [...merged].sort((a, b) => a.localeCompare(b));
}

/**
 * Full dropdown / datalist options: all presets + every model id saved in this browser + optional extras
 * (e.g. runtime default, current field value). Not filtered by provider — any model id can pair with any connection.
 */
export function getModelIdOptionsForPicker(extraIds: readonly string[] = []): string[] {
  const merged = new Set<string>([
    ...getAllPresetModelIds(),
    ...collectRememberedModelIds(),
    ...extraIds.map((id) => id.trim()).filter(Boolean),
  ]);
  return [...merged].sort((a, b) => a.localeCompare(b));
}
