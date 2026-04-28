# Voice Parity Sweep + Routing Guard (2026-04-28)

## Objective

Enforce full voice-feature parity between:

- `ghoststack-rag/ui` (GhostDASH UI)
- `/var/Ghost-chatUI` (actual `/ghost_chatui/` operator page)

and add persistent guardrails so edits route to the correct repo/surface.

## Runtime evidence snapshot

- `git status -sb` captured before work.
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'` captured active services.
- `docker logs --tail=120 ghost-edge-gateway` -> container not present.
- `docker logs --tail=120 ghost-control-plane` -> container not present.

## Parity changes applied to `/var/Ghost-chatUI`

### New voice mastering state model

- Added `src/lib/voiceMasteringSettings.ts`:
  - full ElevenLabs mastering payload model (`model_id`, `language_code`, `seed`, `previous_text`, `next_text`, normalization, voice settings, dictionary locators, replacements)
  - per-agent voice mapping
  - per-agent mastering config
  - reusable preset storage
  - autosave + clone + normalize helpers.

### API contract parity

- Updated `src/lib/types/chat.ts` with `ElevenLabsMasteringPayload`.
- Updated `src/lib/providers/api.ts`:
  - `synthesizeElevenLabsSpeech(...)` now accepts/forwards mastering payload.
  - `buildTtsStreamUrl(...)` now forwards mastering query params for websocket TTS stream.

### Chat page behavior parity

- Updated `src/App.tsx`:
  - migrated speak response + voice selection into persistent per-agent draft/saved state
  - added full mastering payload propagation to:
    - ElevenLabs preview fallback
    - `/agent/voice/tts-stream` websocket
  - added right-side translucent **Admin mastering panel** with:
    - core knobs
    - pacing/deterministic controls
    - text preprocessing controls
    - pronunciation locators/replacements
    - preset save/apply/delete
    - quick save/revert
    - autosave toggle
  - preserved/extended streaming smoothing path:
    - `AudioContext` chunk scheduling
    - no overlap queue discipline
    - stop/cancel handling.

- Updated `src/components/chat/Composer.tsx`:
  - added Mastering button to open panel
  - surfaced autosave indicator in voice status line.

## Rules hardening (prevent recurrence)

### Added always-apply Cursor rule

- `ghoststack-rag/.cursor/rules/06-chat-surface-repo-routing.mdc`
  - requires URL/surface -> repo mapping before edits
  - hard stop behavior for `ghost_chatui` to route edits to `/var/Ghost-chatUI`
  - explicit parity reporting expectation (`both` / one-sided).

### Updated repo operating rules

- `ghoststack-rag/AGENTS.md`
  - added source-of-truth mapping bullets:
    - `ghost_chatui` implementation in `/var/Ghost-chatUI`
    - `ghoststack-rag/ui` is separate GhostDASH UI surface.

## Build and verification

1. `docker compose up -d --build ghost-chatui agent-ingress`
   - built `ghost-chatui` image with new assets:
     - `index-3zmZQcHV.js`
     - `index-ChgaCuMO.css`
2. `ReadLints` on changed `/var/Ghost-chatUI` files -> no lint diagnostics.

## Current parity status

- Voice streaming smoothing + stop/cancel behavior: **both**
- Mic optional open-streaming behavior: **both**
- ElevenLabs mastering panel/presets/autosave/revert: **both**
