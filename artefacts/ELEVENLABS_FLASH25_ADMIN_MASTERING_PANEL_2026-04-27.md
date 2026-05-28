# ElevenLabs Flash v2.5 Admin Mastering Panel (Ghost ChatUI)

## Goal

Expose all operator-facing ElevenLabs Flash v2.5 mastering controls in `ghost_chatui`, support preset save/recall across agents/voices, and make edits persist/revert quickly while allowing live-update attempts during active streaming sessions.

## Implementation Summary

### Frontend state + persistence

- Extended `ui/src/lib/ghostChatStreamingSettings.ts` from a simple `speakResponses + voiceByAgentId` model to:
  - `masteringByAgentId` (per-agent full mastering profile)
  - `presets` (cross-agent reusable mastering presets)
  - `autoSaveMastering` (dynamic persistence toggle)
- Added migration path from `ghostdash.ghostChat.streaming.v1` to `v2`.
- Added helpers for:
  - full defaults (`defaultElevenLabsMasteringSettings`)
  - normalization/clamping
  - per-agent resolve/update
  - deep cloning for safe save/revert.

### Frontend UI

- Updated `ui/src/components/GhostChat.tsx`:
  - new right-side translucent mastering panel (`bg-white/40`, blurred, popup style)
  - full parameter controls:
    - stability
    - similarity boost
    - style
    - use speaker boost
    - speed
    - language code
    - model id
    - seed (+ randomize)
    - previous text / next text
    - apply text normalization
    - pronunciation dictionary locators list
    - custom key->value pronunciation replacements list
  - preset handling:
    - Save Preset (name + JSON settings snapshot)
    - Apply preset to active agent
    - Delete preset
  - quick revert:
    - revert to last saved state and persist immediately
  - optional dynamic autosave:
    - persists every edit when enabled.

### Frontend API payloading

- Expanded `ui/src/api.ts` with ElevenLabs mastering payload types and extended:
  - `fetchElevenLabsPreviewMpeg(...)` to forward full mastering payload to `/agent/voice/preview`.
  - `buildVoiceStreamUrl(...)` to include key mastering params in stream URL query for live sessions.
- Updated `ui/src/lib/elevenlabsTtsQueue.ts`:
  - queue now fetches audio with current mastering payload on each sentence chunk.
  - enables live tuning impact mid-response for subsequent chunks.

### Backend request contract

- Extended `backend/src/ghostdash_api/voice_ingress.py` `VoicePreviewRequest` to accept:
  - `model_id`, `language_code`, `seed`, `previous_text`, `next_text`
  - `apply_text_normalization`
  - `voice_settings` including style/use_speaker_boost/speed
  - `pronunciation_dictionary_locators`
  - `pronunciation_replacements`
- Added pronunciation replacement preprocessing (`key -> value`) before ElevenLabs call.
- Switched preview call payload to use submitted Flash v2.5-style mastering settings.

## Runtime/Diagnostics Snapshot Used

- `git status -sb` at `/var/llamaindex` (not a repo) then at `/var/llamaindex/ghoststack-rag` (active dirty repo).
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'` captured active stack.
- Requested logs for `ghost-edge-gateway` and `ghost-control-plane` returned container-not-found (different runtime naming).

## Validation Performed

1. Python syntax check:
   - `python3.12 -m compileall backend/src/ghostdash_api/voice_ingress.py`
2. UI lint + build in container:
   - `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
3. Lints on modified files:
   - no IDE lint errors reported for touched files.

## Human E2E Validation Checklist (Required)

1. Open `ghost_chatui` and open the Voice tools section.
2. Open **Mastering Panel** and tune settings (stability/speed/seed/etc).
3. Start chat with **Speak response** enabled and verify:
   - changed settings affect subsequent spoken chunks.
4. Save two presets (example: Narrator/Assistant) and apply across two different agents.
5. Switch ElevenLabs voice and re-apply saved preset to verify voice-agnostic preset recall.
6. Change values, then click **Quick revert to last saved** and confirm rollback + persistence after reload.
7. If voice streaming socket is active, change mastering settings and confirm no break in session plus best-effort live update behavior.

## Notes / Risk

- `/agent/voice/stream` currently reports unimplemented server-side realtime proxy in this build, so live update is best-effort for that channel.
- Chat TTS path (`/agent/voice/preview`) receives full mastering params and supports dynamic tuning across sentence chunks.
