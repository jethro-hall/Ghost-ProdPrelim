# ElevenLabs Streaming TTS Smooth Playback Fix

## Defect

GhostChat speech playback sounded jumpy and uneven because each sentence triggered a separate `/agent/voice/preview` MP3 request, then local queue stitching introduced hard gaps.

## Root Cause

1. Per-sentence HTTP generation path (`/voice/preview`) created transport and decode boundaries.
2. Playback was audio-element based chunk-by-chunk, increasing startup gaps.
3. Existing `/agent/voice/tts-stream` websocket proxy drained too few upstream audio frames per text payload.

## Implemented Solution

### Frontend

- Reworked `ui/src/lib/elevenlabsTtsQueue.ts` to default to one websocket streaming TTS session per assistant turn via `/agent/voice/tts-stream`.
- Buffering changed from rigid sentence chunking to natural clause extraction.
- Streamed audio chunks are decoded in `AudioContext` and scheduled back-to-back (`nextPlaybackTime`) to avoid overlap and minimize cadence gaps.
- `stop()` now:
  - cancels active websocket session,
  - clears pending text and fallback queue,
  - stops active scheduled sources,
  - halts currently playing fallback audio.
- Added MP3 preview fallback path only when streaming socket fails.
- `Speak responses` off now hard-stops active TTS immediately and prevents additional requests.

### API Client

- Added `buildVoiceTtsStreamUrl(...)` in `ui/src/api.ts` with mastering params for streaming setup.

### Backend

- Extended `/agent/voice/tts-stream` query parsing in `backend/src/ghostdash_api/voice_ingress.py`:
  - `model_id`, `language_code`, `seed`,
  - `stability`, `similarity_boost`, `style`, `use_speaker_boost`, `speed`,
  - `apply_text_normalization`, `previous_text`, `next_text`.
- TTS websocket now forwards a richer init payload to ElevenLabs stream-input.
- Improved frame draining behavior:
  - no premature single-frame break,
  - flush/end drain more audio before completion,
  - better finalization handling.

## Files Changed

- `ui/src/lib/elevenlabsTtsQueue.ts`
- `ui/src/api.ts`
- `ui/src/components/GhostChat.tsx`
- `backend/src/ghostdash_api/voice_ingress.py`

## Validation Performed

1. `python3.12 -m compileall backend/src/ghostdash_api/voice_ingress.py`
2. `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
3. Lint diagnostics for changed files: no errors.

## Follow-up defect fix (Open Streaming mic NotFoundError)

- Symptom observed: `NotFoundError: Requested device not found` while opening streaming in environments without an available microphone.
- Root cause: UI treated `getUserMedia({ audio: true })` as mandatory before stream socket open.
- Fix in `ui/src/components/GhostChat.tsx`:
  - microphone capture is now optional,
  - `getUserMedia` failures no longer block stream open,
  - status message explains fallback path,
  - preflight copy updated to reflect optional mic behavior.
- Verification:
  - `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint"`

## Human E2E Test Plan (Required)

1. Ask a 3-4 sentence question and listen for continuous cadence.
2. Verify first words are not clipped.
3. Verify no overlapping audio during long answers.
4. Press **Stop speaking** mid-answer and confirm immediate stop.
5. Disable **Speak responses** and confirm no TTS network activity.
6. Compare network requests against old behavior: fewer TTS calls expected (single websocket stream per turn, fallback excluded).
7. Validate intelligibility on normal laptop/speaker output.
