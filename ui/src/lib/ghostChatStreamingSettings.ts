const STORAGE_KEY = "ghostdash.ghostChat.streaming.v2";

export type ApplyTextNormalization = "auto" | "on" | "off";

export type ElevenLabsVoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
};

export type ElevenLabsPronunciationDictionaryLocator = {
  pronunciation_dictionary_id: string;
  version_id: string;
};

export type ElevenLabsPronunciationReplacement = {
  key: string;
  value: string;
};

export type ElevenLabsMasteringSettings = {
  model_id: string;
  language_code: string;
  seed: number | null;
  previous_text: string;
  next_text: string;
  apply_text_normalization: ApplyTextNormalization;
  voice_settings: ElevenLabsVoiceSettings;
  pronunciation_dictionary_locators: ElevenLabsPronunciationDictionaryLocator[];
  pronunciation_replacements: ElevenLabsPronunciationReplacement[];
};

export type ElevenLabsMasteringPreset = {
  id: string;
  name: string;
  settings: ElevenLabsMasteringSettings;
  updated_at: string;
};

export type GhostChatStreamingState = {
  /** Play assistant audio after chat responses (ElevenLabs). */
  speakResponses: boolean;
  /** Persist edits immediately as the operator tweaks controls. */
  autoSaveMastering: boolean;
  /** Per-agent chosen ElevenLabs `voice_id`. */
  voiceByAgentId: Record<string, string>;
  /** Per-agent mastering profile used by ElevenLabs preview / streaming. */
  masteringByAgentId: Record<string, ElevenLabsMasteringSettings>;
  /** Reusable presets that can be applied to any agent + voice. */
  presets: ElevenLabsMasteringPreset[];
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeVoiceSettings(value: Partial<ElevenLabsVoiceSettings> | null | undefined): ElevenLabsVoiceSettings {
  return {
    stability: clamp(Number(value?.stability ?? 0.5), 0, 1),
    similarity_boost: clamp(Number(value?.similarity_boost ?? 0.75), 0, 1),
    style: clamp(Number(value?.style ?? 0), 0, 1),
    use_speaker_boost: Boolean(value?.use_speaker_boost ?? true),
    speed: clamp(Number(value?.speed ?? 1), 0.7, 1.2),
  };
}

function normalizeDictionaryLocators(
  value: unknown,
): ElevenLabsPronunciationDictionaryLocator[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const locator = entry as Partial<ElevenLabsPronunciationDictionaryLocator>;
      const pronunciation_dictionary_id = String(locator.pronunciation_dictionary_id ?? "").trim();
      const version_id = String(locator.version_id ?? "").trim();
      if (!pronunciation_dictionary_id && !version_id) return null;
      return { pronunciation_dictionary_id, version_id };
    })
    .filter((entry): entry is ElevenLabsPronunciationDictionaryLocator => Boolean(entry));
}

function normalizePronunciationReplacements(
  value: unknown,
): ElevenLabsPronunciationReplacement[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const replacement = entry as Partial<ElevenLabsPronunciationReplacement>;
      const key = String(replacement.key ?? "").trim();
      const valueText = String(replacement.value ?? "").trim();
      if (!key && !valueText) return null;
      return { key, value: valueText };
    })
    .filter((entry): entry is ElevenLabsPronunciationReplacement => Boolean(entry));
}

export function defaultElevenLabsMasteringSettings(): ElevenLabsMasteringSettings {
  return {
    model_id: "eleven_flash_v2_5",
    language_code: "en",
    seed: null,
    previous_text: "",
    next_text: "",
    apply_text_normalization: "auto",
    voice_settings: normalizeVoiceSettings(undefined),
    pronunciation_dictionary_locators: [],
    pronunciation_replacements: [],
  };
}

export function cloneMasteringSettings(settings: ElevenLabsMasteringSettings): ElevenLabsMasteringSettings {
  return {
    ...settings,
    voice_settings: { ...settings.voice_settings },
    pronunciation_dictionary_locators: settings.pronunciation_dictionary_locators.map((entry) => ({ ...entry })),
    pronunciation_replacements: settings.pronunciation_replacements.map((entry) => ({ ...entry })),
  };
}

function normalizeMasteringSettings(value: Partial<ElevenLabsMasteringSettings> | null | undefined): ElevenLabsMasteringSettings {
  const defaults = defaultElevenLabsMasteringSettings();
  const seedRaw = value?.seed;
  const seed = typeof seedRaw === "number" && Number.isFinite(seedRaw) ? Math.max(0, Math.floor(seedRaw)) : null;
  const normalization = value?.apply_text_normalization;
  return {
    model_id: String(value?.model_id ?? defaults.model_id).trim() || defaults.model_id,
    language_code: String(value?.language_code ?? defaults.language_code).trim() || defaults.language_code,
    seed,
    previous_text: String(value?.previous_text ?? ""),
    next_text: String(value?.next_text ?? ""),
    apply_text_normalization:
      normalization === "on" || normalization === "off" || normalization === "auto"
        ? normalization
        : defaults.apply_text_normalization,
    voice_settings: normalizeVoiceSettings(value?.voice_settings),
    pronunciation_dictionary_locators: normalizeDictionaryLocators(value?.pronunciation_dictionary_locators),
    pronunciation_replacements: normalizePronunciationReplacements(value?.pronunciation_replacements),
  };
}

function emptyState(): GhostChatStreamingState {
  return {
    speakResponses: false,
    autoSaveMastering: true,
    voiceByAgentId: {},
    masteringByAgentId: {},
    presets: [],
  };
}

function normalizeState(parsed: Partial<GhostChatStreamingState> | null | undefined): GhostChatStreamingState {
  const fromParsed = parsed ?? {};
  const next: GhostChatStreamingState = {
    speakResponses: Boolean(fromParsed.speakResponses),
    autoSaveMastering: fromParsed.autoSaveMastering !== false,
    voiceByAgentId:
      typeof fromParsed.voiceByAgentId === "object" && fromParsed.voiceByAgentId
        ? Object.fromEntries(
            Object.entries(fromParsed.voiceByAgentId).map(([agentId, voiceId]) => [agentId, String(voiceId ?? "").trim()]),
          )
        : {},
    masteringByAgentId: {},
    presets: [],
  };

  if (fromParsed.masteringByAgentId && typeof fromParsed.masteringByAgentId === "object") {
    for (const [agentId, settings] of Object.entries(fromParsed.masteringByAgentId)) {
      next.masteringByAgentId[agentId] = normalizeMasteringSettings(settings);
    }
  }

  if (Array.isArray(fromParsed.presets)) {
    next.presets = fromParsed.presets
      .map((preset) => {
        if (!preset || typeof preset !== "object") return null;
        const raw = preset as Partial<ElevenLabsMasteringPreset>;
        const id = String(raw.id ?? "").trim() || crypto.randomUUID();
        const name = String(raw.name ?? "").trim();
        if (!name) return null;
        return {
          id,
          name,
          updated_at: String(raw.updated_at ?? new Date().toISOString()),
          settings: normalizeMasteringSettings(raw.settings),
        };
      })
      .filter((preset): preset is ElevenLabsMasteringPreset => Boolean(preset));
  }
  return next;
}

export function cloneStreamingState(state: GhostChatStreamingState): GhostChatStreamingState {
  return {
    ...state,
    voiceByAgentId: { ...state.voiceByAgentId },
    masteringByAgentId: Object.fromEntries(
      Object.entries(state.masteringByAgentId).map(([agentId, settings]) => [agentId, cloneMasteringSettings(settings)]),
    ),
    presets: state.presets.map((preset) => ({
      ...preset,
      settings: cloneMasteringSettings(preset.settings),
    })),
  };
}

export function readGhostChatStreamingState(): GhostChatStreamingState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return normalizeState(JSON.parse(raw) as Partial<GhostChatStreamingState>);
    }
    // Migration path for v1 data.
    const legacyRaw = localStorage.getItem("ghostdash.ghostChat.streaming.v1");
    if (!legacyRaw) return emptyState();
    const legacy = JSON.parse(legacyRaw) as Partial<GhostChatStreamingState>;
    return normalizeState({
      speakResponses: legacy.speakResponses,
      voiceByAgentId: legacy.voiceByAgentId,
    });
  } catch {
    return emptyState();
  }
}

export function writeGhostChatStreamingState(state: GhostChatStreamingState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota / private mode
  }
}

export function resolveMasteringForAgent(state: GhostChatStreamingState, agentId: string | null | undefined): ElevenLabsMasteringSettings {
  if (!agentId) return defaultElevenLabsMasteringSettings();
  return state.masteringByAgentId[agentId] ? cloneMasteringSettings(state.masteringByAgentId[agentId]) : defaultElevenLabsMasteringSettings();
}

export function updateMasteringForAgent(
  state: GhostChatStreamingState,
  agentId: string,
  updater: (current: ElevenLabsMasteringSettings) => ElevenLabsMasteringSettings,
): GhostChatStreamingState {
  const current = state.masteringByAgentId[agentId] ?? defaultElevenLabsMasteringSettings();
  const next = normalizeMasteringSettings(updater(cloneMasteringSettings(current)));
  return {
    ...state,
    masteringByAgentId: {
      ...state.masteringByAgentId,
      [agentId]: next,
    },
  };
}

export function pickVoiceIdForAgent(args: {
  agentId: string;
  /** Agent's configured `voice_id` (may be OpenAI-style; ignored if not in list). */
  agentVoiceId: string;
  state: GhostChatStreamingState;
  /** Allowlisted provider voices. */
  validVoiceIds: Set<string>;
  /** Server default or first in list. */
  fallbackVoiceId: string;
}): string {
  const fromUser = args.state.voiceByAgentId[args.agentId]?.trim();
  if (fromUser && args.validVoiceIds.has(fromUser)) {
    return fromUser;
  }
  const fromAgent = args.agentVoiceId.trim();
  if (fromAgent && args.validVoiceIds.has(fromAgent)) {
    return fromAgent;
  }
  if (args.validVoiceIds.has(args.fallbackVoiceId)) {
    return args.fallbackVoiceId;
  }
  const [first] = args.validVoiceIds;
  return first ?? "";
}
