---
title: fix: Stand Up GhostDash Voice Snap-In
type: fix
status: active
date: 2026-04-28
source_package: scripts/ghostdash_voice_snapin_handover.zip
---

# fix: Stand Up GhostDash Voice Snap-In

## Overview

The microphone button currently does not provide a reliable voice experience because the last build only stood up the ElevenLabs Flash 2.5 realtime TTS playback path. It did not fully replace the existing microphone/STT controls with the supplied snap-in module, and production chat still has a microphone button with no attached dictation behavior.

This plan stands up `scripts/ghostdash_voice_snapin_handover.zip` as the shared voice control module for both `/ghost_chatui/` and `/prod_chatui/`: microphone permission, browser STT, live EQ meter, transcript insertion, Flash 2.5 realtime TTS, stop/cancel, and human E2E verification.

---

## Problem Frame

Current state from diagnosis:

- `/ghost_chatui/` still uses local `createSpeechRecognition()` logic in `src/App.tsx`, without a visible EQ meter or the snap-in lifecycle.
- `/prod_chatui/` renders a microphone button in `src/components/production/ProductionComposer.tsx`, but the button has no behavior.
- The current TTS hook `src/lib/useElevenFlash25RealtimeSpeech.ts` watches assistant messages after they appear instead of using the snap-in handoff points: preconnect before stream, send each assistant delta, finish on done.
- `agent-ingress` logs show `WebSocketDisconnect` traces from `backend/src/ghostdash_api/elevenlabs_flash25_realtime.py` when the browser closes before the final event send. That should be handled quietly.

The supplied snap-in is the correct source of truth for the next change. It provides:

- `src/ghostdashVoiceSnapIn/ghostDashVoiceRealtimeClient.ts`
- `src/ghostdashVoiceSnapIn/useGhostDashVoiceSnapIn.ts`
- `src/ghostdashVoiceSnapIn/GhostDashVoiceSnapIn.tsx`
- `src/ghostdashVoiceSnapIn/ghostDashVoiceSnapIn.css`

---

## Requirements Trace

- R1. Clicking the microphone asks for permission when needed and starts dictation when supported.
- R2. While listening, the UI shows a live EQ/signal meter so the user can tell the mic is active.
- R3. Final STT transcript is inserted into the active composer for the correct chat surface.
- R4. Assistant streaming deltas are sent to the Flash 2.5 realtime WebSocket as they arrive, not after the full response.
- R5. Stop Speaking and Stop Generating immediately cancel queued and active audio.
- R6. `/ghost_chatui/` keeps Agent Lab diagnostics and workflow controls while using the new snap-in voice controls.
- R7. `/prod_chatui/` gets working mic/STT and voice controls without exposing traces, citations, backend errors, or raw payloads.
- R8. ElevenLabs API key remains server-side only.
- R9. Human E2E verification must prove mic, transcript, streaming speech, cancellation, and no overlapping playback.
- R10. This work is scoped only to the GhostDash Voice Snap-In and does not replace the separate Magic Mike runtime/category/cache/prompt audit.
- R11. Voice snap-in rollout must be guarded by `VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN=true`; when false, text chat must continue without the snap-in.
- R12. Voice must never block text chat. Mic, STT, ElevenLabs WebSocket, and AudioContext failures must degrade to safe UI status while chat continues.
- R13. `prepareAssistantSpeech()` may only run when speak responses are enabled, an ElevenLabs voice ID is configured, and the backend realtime route is available.
- R14. Stop Generating must cancel the LLM stream and call `voice.stopSpeaking()` to clear current and queued audio.
- R15. Streaming proof must show one backend WebSocket connection for TTS and no repeated MP3 preview calls.

---

## Scope Boundaries

- Do not build a new chat API.
- Do not duplicate chat state.
- Do not proxy ElevenLabs directly from the browser.
- Do not remove the Agent Lab diagnostics from `/ghost_chatui/`.
- Do not claim full production phone-call STT; the snap-in uses browser SpeechRecognition for UI testing. Production phone calls remain a separate ElevenLabs/Twilio/backend STT concern.
- Do not reintroduce per-sentence MP3 preview calls as the streaming path.
- Do not start or subsume the Magic Mike runtime/category/cache/prompt audit in this task.
- Do not delete previous voice code until snap-in E2E passes. Retire it from active use first, then clean up after proof in follow-up work.

---

## Context & Research

### Relevant Code and Patterns

- `scripts/ghostdash_voice_snapin_handover/CURSOR_HANDOVER.md`: authoritative handover and acceptance tests.
- `scripts/ghostdash_voice_snapin_handover/BACKEND_REQUIREMENT.md`: confirms backend route requirement.
- `backend/src/ghostdash_api/elevenlabs_flash25_realtime.py`: currently mounted Flash 2.5 backend route.
- `backend/src/ghostdash_api/agent_ingress.py`: chat SSE stream and route registration owner.
- `Caddyfile`: routes `/api/voice/elevenlabs/*` to `agent-ingress`.
- `src/lib/state/useGhostChat.ts`: canonical owner of chat send, assistant delta, done, and stop lifecycle.
- `src/App.tsx`: current `/ghost_chatui/` shell and old mic logic.
- `src/pages/ProductionChatPage.tsx`: production chat shell, currently missing mic/STT behavior.
- `src/components/chat/Composer.tsx`: Agent Lab composer controls.
- `src/components/production/ProductionComposer.tsx`: production composer controls.

### Diagnostic Findings

- `docker ps` confirms `ghost-chatui`, `agent-ingress`, `control-api`, and `caddy` are running.
- `docker logs --tail=120 ghoststack-rag-agent-ingress-1` shows healthy chat streams and health checks, plus `WebSocketDisconnect` traces in `elevenlabs_flash25_realtime.py` final send.
- `docker logs --tail=120 ghoststack-rag-control-api-1` shows normal health and conversation API traffic.

---

## Key Technical Decisions

- Use the snap-in package as the single voice UI module instead of patching the old mic button. The package includes the missing EQ meter, STT lifecycle, and TTS lifecycle.
- Put snap-in activation behind `VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN`, defaulting to enabled for this build. If disabled, text chat works and the old voice code remains inactive but present.
- Keep `useGhostChat` as the single chat state owner. Add optional voice lifecycle callbacks rather than creating a second chat stream.
- Wire TTS at stream lifecycle boundaries: prepare before deltas, speak on each delta, finish on done, cancel on stop.
- Make all voice lifecycle callbacks best-effort. They must catch failures and return safe statuses without throwing into chat send or stream handling.
- Render the same snap-in control in both chat surfaces, styled appropriately per surface.
- Replace the current inert production mic button with snap-in dictation controls.
- Fix backend WebSocket disconnect handling so normal user cancellation does not log noisy server traces.

---

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

```text
User clicks mic
-> GhostDashVoiceSnapIn.startDictation()
-> browser getUserMedia + SpeechRecognition
-> EQ bars show mic signal
-> final transcript callback
-> active composer text updated

User sends message
-> useGhostChat.handleSend()
-> voice.prepareAssistantSpeech(previousText: user prompt)
-> /agent/chat/stream emits assistant deltas
-> voice.speakAssistantDelta(delta)
-> /api/voice/elevenlabs/flash25/realtime
-> ElevenLabs stream-input
-> PCM audio chunks
-> AudioContext playback
-> stream done calls voice.finishAssistantSpeech()
```

---

## Implementation Units

- [ ] U1. **Install snap-in module in Ghost ChatUI**

**Goal:** Add the snap-in files from the handover package into the UI repo with minimal adaptation to local TypeScript and styling conventions.

**Requirements:** R1, R2, R4, R5, R8

**Dependencies:** None

**Files:**
- Create: `src/ghostdashVoiceSnapIn/ghostDashVoiceRealtimeClient.ts`
- Create: `src/ghostdashVoiceSnapIn/useGhostDashVoiceSnapIn.ts`
- Create: `src/ghostdashVoiceSnapIn/GhostDashVoiceSnapIn.tsx`
- Create: `src/ghostdashVoiceSnapIn/ghostDashVoiceSnapIn.css`
- Create: `src/lib/voiceSnapInConfig.ts`
- Modify: `src/styles/index.css` if global import is needed
- Modify: `src/vite-env.d.ts`
- Test: `src/test/ghostdash-voice-snapin.test.tsx`

**Approach:**
- Prefer the supplied snap-in files over the earlier `src/lib/useElevenFlash25RealtimeSpeech.ts` implementation.
- Add `VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN` config parsing in one small helper so both chat surfaces use the same rollback behavior.
- Keep ElevenLabs API key out of the frontend.
- Preserve custom replacements for Ride Electric terms such as `VSETT` and `Fatfish`.

**Test scenarios:**
- Happy path: render `GhostDashVoiceSnapIn` with idle hook state -> mic, speak response, stop speaking, and meter elements are visible.
- Happy path: config helper treats `VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN=true` and unset as enabled.
- Edge case: config helper treats `VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN=false` as disabled and voice UI does not block text chat.
- Edge case: SpeechRecognition unavailable -> hook reports unsupported STT without throwing.
- Error path: microphone permission rejection -> state becomes error and callback receives a safe message.
- Integration: stop speaking calls client cancel and clears queued playback.

**Verification:**
- Snap-in compiles in the existing Vite/React app.
- No duplicate voice client remains as the active path.

---

- [ ] U2. **Expose voice lifecycle hooks from chat state**

**Goal:** Let the single chat state owner call voice lifecycle events without duplicating stream state.

**Requirements:** R3, R4, R5

**Dependencies:** U1

**Files:**
- Modify: `src/lib/state/useGhostChat.ts`
- Modify: `src/lib/types/chat.ts`
- Test: `src/test/useGhostChat-voice-lifecycle.test.tsx`

**Approach:**
- Add optional callbacks/config to `useGhostChat` for:
  - before send / prepare speech
  - assistant delta
  - stream done
  - stop generating
- Keep existing provider and SSE handling unchanged except for emitting these lifecycle callbacks.
- Ensure callback failures cannot break chat streaming.
- Call `prepareAssistantSpeech()` only after verifying the voice gate supplied by the UI says voice is available. If unavailable, skip silently and expose only safe UI status.

**Test scenarios:**
- Happy path: sending a message calls prepare before the first assistant delta.
- Happy path: each `onDelta` callback receives exactly the streamed delta text.
- Happy path: `onDone` calls finish once.
- Error path: callback throws -> chat message still streams and the error is contained.
- Error path: prepare rejects because WebSocket/AudioContext fails -> text stream still starts and completes.
- Integration: `stopGenerating` calls voice cancel.

**Verification:**
- Text chat behavior is unchanged when voice callbacks are absent.
- Voice-enabled chat receives stream lifecycle events in order.

---

- [ ] U3. **Replace `/ghost_chatui/` voice controls with snap-in**

**Goal:** Make Agent Lab microphone and speech controls actually use the snap-in while preserving diagnostics.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** U1, U2

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/chat/Composer.tsx`
- Test: `src/test/ghost-chatui-voice-controls.test.tsx`

**Approach:**
- Remove the old `createSpeechRecognition()` mic flow from `App.tsx`.
- Instantiate `useGhostDashVoiceSnapIn()` in the shell or a focused controller component.
- Pass the snap-in API to `Composer`.
- Render `GhostDashVoiceSnapIn` near the existing composer voice controls.
- On transcript final, append or replace the composer input in the same way the current mic flow intended.
- When the rollback flag is false, do not render the snap-in and leave text chat behavior unchanged.

**Test scenarios:**
- Happy path: clicking mic calls `startDictation`.
- Happy path: final transcript updates composer input.
- Happy path: Stop Speaking calls snap-in stop.
- Edge case: disabled composer does not start dictation.
- Integration: diagnostics and right panel still render in Agent Lab.

**Verification:**
- `/ghost_chatui/` still looks like Agent Lab.
- Mic click has visible state change and EQ meter path.

---

- [ ] U4. **Replace `/prod_chatui/` inert mic button with snap-in**

**Goal:** Give production chat the same working mic/STT and Flash 2.5 voice path without leaking diagnostics.

**Requirements:** R1, R2, R3, R5, R7

**Dependencies:** U1, U2

**Files:**
- Modify: `src/pages/ProductionChatPage.tsx`
- Modify: `src/components/production/ProductionComposer.tsx`
- Test: `src/test/production-voice-snapin.test.tsx`

**Approach:**
- Instantiate the same snap-in hook using the production-safe chat state.
- Replace the inert production mic button with the snap-in control.
- Keep public-safe status text. Do not render raw WebSocket errors or backend traces.
- Use safe production status such as: "Voice is unavailable right now. Text chat still works."
- Keep the production advanced drawer behavior unchanged.

**Test scenarios:**
- Happy path: production mic click calls `startDictation`.
- Happy path: final transcript updates production composer input.
- Error path: unavailable STT renders a safe customer-facing message.
- Integration: production messages still pass through the public presenter.

**Verification:**
- `/prod_chatui/` has working voice controls.
- No traces, raw errors, citations, scorecards, or diagnostic payloads appear.

---

- [ ] U5. **Harden backend realtime WebSocket cleanup**

**Goal:** Stop normal browser cancellation/disconnect from producing noisy ASGI traces.

**Requirements:** R5, R8

**Dependencies:** None

**Files:**
- Modify: `backend/src/ghostdash_api/elevenlabs_flash25_realtime.py`
- Test: `backend/tests/test_elevenlabs_flash25_realtime.py`

**Approach:**
- Extend safe send handling to catch WebSocket disconnect/client disconnected cases, not only runtime errors.
- Ensure final cleanup closes upstream ElevenLabs WebSocket and pending tasks without double-sending final events.
- Preserve safe public error strings.
- Preserve route availability probing so the frontend can decide whether `prepareAssistantSpeech()` should run.

**Test scenarios:**
- Error path: client disconnect before final -> handler exits without raising.
- Error path: invalid start message -> safe validation error response.
- Happy path: cancel message marks interrupted and closes upstream.

**Verification:**
- Agent ingress logs do not show ASGI stack traces for normal client cancellation.

---

- [ ] U6. **Human E2E verification and artefacts**

**Goal:** Prove the feature from a human perspective and capture results for future architecture reference.

**Requirements:** R9

**Dependencies:** U1, U2, U3, U4, U5

**Files:**
- Create: `artefacts/production-chat/GHOSTDASH_VOICE_SNAPIN_E2E_2026-04-28.md`
- Optional screenshots/video: `artefacts/production-chat/`

**Approach:**
- Test in browser as a human, not just unit tests.
- Verify both chat routes.
- Record findings, fixes, retest results, and remaining limitations.

**Test scenarios:**
- Manual: click mic -> browser permission prompt appears or permission state is shown.
- Manual: speak into mic -> EQ bars move.
- Manual: transcript appears in composer.
- Manual: send message -> assistant begins speaking before full text completion.
- Manual: Stop Speaking stops current and queued audio.
- Manual: Stop Generating cancels audio and LLM stream.
- Manual: regenerate does not overlap audio.
- Manual: network shows one backend WebSocket for TTS, not repeated MP3 preview calls.
- Manual: set `VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN=false`, rebuild, and verify text chat still sends normally without snap-in controls.

**Verification:**
- Human E2E artefact includes screenshots or observed proof for each manual acceptance item.

---

## System-Wide Impact

- **Interaction graph:** Composer mic controls now depend on snap-in state and browser APIs; chat stream lifecycle emits optional voice callbacks.
- **Error propagation:** Browser/STT errors must be shown as safe voice status, not raw backend/tool text.
- **State lifecycle risks:** Voice state must reset on stop, route change, regenerate, and unmount to avoid overlapping audio.
- **API surface parity:** `/ghost_chatui/` and `/prod_chatui/` should share the same voice module, with different presentation only.
- **Integration coverage:** Unit tests alone will not prove mic permission, real audio capture, or browser autoplay restrictions; human E2E is required.
- **Unchanged invariants:** Chat text streaming, public response filtering, Agent Lab diagnostics, and production output guard remain in place.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Browser SpeechRecognition unavailable | Show safe unsupported state and keep text composer usable. |
| Browser audio gesture policy blocks playback | Start audio context from explicit voice/user action via snap-in. |
| Voice callbacks break chat stream | Wrap callbacks so chat stream continues even if voice fails. |
| Duplicate audio clients overlap | Remove/retire active use of the previous `useElevenFlash25RealtimeSpeech` path. |
| Production UI leaks backend errors | Map voice errors to safe customer-facing status text. |
| Backend logs noisy disconnect traces | Harden WebSocket cleanup and add regression coverage. |

---

## Acceptance Criteria

- Clicking mic in `/ghost_chatui/` starts dictation or shows a clear safe unsupported/permission message.
- Clicking mic in `/prod_chatui/` starts dictation or shows a clear safe unsupported/permission message.
- EQ meter moves when the microphone receives signal.
- Final transcript appears in the composer.
- Assistant TTS starts before the full text answer completes.
- Stop Speaking and Stop Generating cancel audio immediately.
- No overlapping playback after regenerate or a new message.
- No per-sentence MP3 preview calls are used for streaming speech.
- `VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN=false` disables snap-in without breaking text chat.
- `/prod_chatui/` remains production-safe.
- Agent ingress logs do not show WebSocket disconnect stack traces for normal voice cancellation.

---

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-agent-ingress-1
docker logs --tail=120 ghoststack-rag-control-api-1
python3 -m compileall backend/src/ghostdash_api/elevenlabs_flash25_realtime.py backend/src/ghostdash_api/agent_ingress.py
docker compose up -d --build agent-ingress ghost-chatui caddy
```

```bash
cd /var/Ghost-chatUI
npm run lint
npm run build
```

Manual browser verification:

```text
Open https://ghoststack.rideai.com.au/ghost_chatui/
Click mic, allow permission, speak, confirm EQ and transcript.
Send message, confirm Flash 2.5 speech starts during streaming.
Click Stop Speaking and Stop Generating, confirm audio stops.

Open https://ghoststack.rideai.com.au/prod_chatui/
Repeat the same flow and confirm production-safe output.
```

---

## Documentation / Operational Notes

- Write human testing results to `artefacts/production-chat/GHOSTDASH_VOICE_SNAPIN_E2E_2026-04-28.md`.
- Update `artefacts/production-chat/ELEVENLABS_FLASH25_REALTIME_STREAMING_2026-04-28.md` if the previous Flash 2.5 architecture evidence is superseded by the snap-in.
- If browser STT is not available in the test browser, record that as a platform limitation and test microphone permission/EQ separately from transcript insertion.
