# GhostDash Voice Snap-In Evidence - 2026-04-28

## Scope

Implemented the GhostDash Voice Snap-In only. This does not replace or complete the separate Magic Mike runtime/category/cache/prompt audit.

## Build Architecture

- `/ghost_chatui/` keeps the detailed Agent Lab surface.
- `/prod_chatui/` keeps the clean production surface.
- Both routes use `src/ghostdashVoiceSnapIn/*` for active voice controls.
- Previous voice code remains present but retired from active use until snap-in E2E passes.
- Rollback flag: `VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN=true`.
- Rollback behavior: `VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN=false` builds successfully and leaves text chat usable without snap-in controls.

## Safety Guarantees

- Voice lifecycle hooks in `useGhostChat` are best-effort and cannot throw into text chat streaming.
- `prepareAssistantSpeech()` is gated by speak responses, configured ElevenLabs voice ID, and realtime route availability.
- `Stop Generating` cancels the LLM stream and calls `voice.stopSpeaking()` to clear current and queued audio.
- Production voice failures use: `Voice is unavailable right now. Text chat still works.`
- No raw WebSocket/backend errors are shown in production chat.

## Follow-Up Fix: Final STT Text Disappeared

Human testing showed final speech text appearing in the snap-in transcript area, then disappearing without reaching the LLM path.

Root cause:

- Chrome can emit a final `SpeechRecognition` result while recognition stays open.
- The snap-in previously delivered final text only from `recognition.onend`.
- When the browser emitted a final result without ending recognition, the interim display cleared and the composer never received the transcript.

Fix:

- Final STT results are now delivered immediately from `recognition.onresult`.
- `recognition.onend` keeps a duplicate guard so the same final phrase is not delivered twice.
- Added regression coverage in `src/test/ghostdash-voice-snapin.test.tsx`.

## Verification Commands Run

```bash
cd /var/Ghost-chatUI && npm test -- src/test/ghostdash-voice-snapin.test.tsx
cd /var/Ghost-chatUI && npm run lint
cd /var/Ghost-chatUI && npm test
cd /var/Ghost-chatUI && npm run build
cd /var/Ghost-chatUI && VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN=false npm run build
cd /var/Ghost-chatUI && VITE_ENABLE_GHOSTDASH_VOICE_SNAPIN=true npm run build
cd /var/llamaindex/ghoststack-rag && python3 -m compileall backend/src/ghostdash_api/elevenlabs_flash25_realtime.py
cd /var/llamaindex/ghoststack-rag && docker compose up -d --build agent-ingress ghost-chatui caddy
cd /var/llamaindex/ghoststack-rag && docker compose up -d --build ghost-chatui caddy
```

## Results

- Targeted STT regression test: passed.
- TypeScript lint: passed.
- Vitest: 19 files passed, 28 tests passed.
- Production build with snap-in enabled: passed.
- Production build with rollback flag false: passed.
- Backend realtime route compile: passed.
- Docker rebuild: passed.
- Container health/log smoke: passed.

## Realtime WebSocket Proof

Container-level realtime smoke test opened a single backend WebSocket to:

```text
ws://127.0.0.1:8001/api/voice/elevenlabs/flash25/realtime
```

Observed events:

```json
{
  "events_after_ready": ["metrics", "audio", "final"],
  "audio_events": 1,
  "final_metrics": {
    "first_text_sent_ms": 270,
    "first_audio_chunk_ms": 468,
    "text_chunks_sent": 2,
    "audio_chunks_received": 1,
    "audio_bytes_received": 83776,
    "interrupted": false,
    "status": "finishing"
  }
}
```

Browser network proof found no repeated MP3 preview or TTS preview HTTP calls during page load or snap-in interaction. Full browser streaming audio still needs a real microphone/speaker session.

## Human E2E Gate

Pending final human confirmation:

1. Open `/prod_chatui/`.
2. Click `Mic` and allow microphone permission.
3. Speak a short prompt and confirm it lands in the composer immediately.
4. Click `Send` and confirm the prompt reaches the LLM.
5. Enable `Speak response`.
6. Send a prompt and confirm assistant audio plays.
7. Click `Stop` while generating and confirm text stream stops and audio stops.
8. Confirm browser network shows one `/api/voice/elevenlabs/flash25/realtime` WebSocket and no repeated MP3 preview calls.

Current behavior remains deliberate: voice dictation fills the composer, then the user clicks `Send`. Auto-submit is not enabled because speech recognition can finalize partial or incorrect phrases.

## Follow-Up Fix: Production Session Save

Human testing flagged that the `/prod_chatui/` advanced drawer `Session save` button appeared clickable but did nothing.

Root cause:

- `src/components/production/ProductionAdvancedDrawer.tsx` rendered `Session save` and `Revert` buttons without click handlers.
- `src/pages/ProductionChatPage.tsx` had no saved production-session model for advanced controls.

Fix:

- Added local browser persistence for production advanced controls under `ghost-prod-chatui-session-settings`.
- `Session save` now stores selected agent, conversation mode, and MAS-enabled state.
- `Revert` now restores the last saved production controls and reports a visible safe status.
- Saved controls hydrate on page load once agents are available.

Verification:

```bash
cd /var/Ghost-chatUI && npm test -- src/test/production-route.test.tsx
cd /var/Ghost-chatUI && npm run lint && npm test && npm run build
```

Results:

- Targeted production route test passed, including clicking `Session save` and verifying local persistence.
- TypeScript lint passed.
- Full Vitest suite passed: 19 files, 29 tests.
- Production build passed.

## Critical Fix: Production Runtime Contamination And Open Streaming

Human testing exposed that `/prod_chatui/` could answer a normal Magic Mike greeting with stale Odoo/tool-failure wording.

Root cause:

- `/prod_chatui/` only sent a `surface` hint. It did not send or require `route_mode=production_chat`, `agent_category=consumer_customer`, presenter-required, retail-guard-required, or diagnostics-hidden flags.
- `/api/chat/bootstrap?surface=prod_chatui` defaulted to the global default agent (`Llama Architect`) instead of Magic Mike.
- Magic Mike's persisted runtime had inherited owner/operator business guidance from the default business runtime. The request path sanitised it at runtime, and the seed repair now persists the production-safe contract.
- The production presenter blocked some internal strings, but did not block broad Odoo/tool/backend/document-bot wording.
- Production cache is now disabled for `/prod_chatui/` turns because the existing response cache key cannot prove the full required production key set.

Fix:

- `/prod_chatui/` now sends the explicit production contract on every streamed chat request.
- Backend production traffic fails closed unless it resolves to Magic Mike in consumer-customer production mode.
- Production bootstrap now defaults to Magic Mike.
- Magic Mike's seed repair clears owner/operator business guidance and persists:
  - `agent_category=consumer_customer`
  - `route_mode=production_chat`
  - `public_presenter_required=true`
  - `retail_output_guard_required=true`
  - `diagnostics_visible=false`
- Greeting intent bypasses planner/tools/retrieval and returns: `I’m good, thanks. What can I help you sort out with Ride Electric?`
- Magic Mike production tool plans are forced to `none`; Odoo is not available to Magic Mike in production mode.
- Retail Output Guard now blocks Odoo, tool blocked, backend, orchestrator, citations, scorecard, database, provided documents, grounded information, raw payload, and trace wording before display/voice.
- Open Streaming is now a real stateful controller:
  - `Open Streaming` starts continuous STT.
  - interim transcript displays only.
  - final transcript auto-submits once after debounce.
  - barge-in stops active LLM generation and ElevenLabs audio.
  - `End Streaming` stops mic, LLM, and audio.

Live proof:

```text
/prod_chatui bootstrap default_agent_id = d0cbb7e2-45cd-4605-bc01-fb860c7f7531
default agent = Magic Mike
enabled tools = kb, web
agent_category = consumer_customer
route_mode = production_chat
public_presenter_required = true
retail_output_guard_required = true
diagnostics_visible = false
owner_operator_questionnaire_compact = ""
```

Before/after greeting:

```text
Before:
Hi! I'm doing well, thanks for asking. Regarding your question about the Odoo tool, it was blocked and did not execute...

After:
I’m good, thanks. What can I help you sort out with Ride Electric?
```

Browser E2E notes:

- Opened `https://ghoststack.rideai.com.au/prod_chatui/?v=prod-runtime-open-streaming`.
- Confirmed top bar shows `Magic Mike · quick · production-safe output`.
- Confirmed advanced agent selector only exposes `Magic Mike`.
- Confirmed existing greeting answer contains no Odoo/tool/backend/debug language.
- Clicked `Open Streaming`; button changed to `End Streaming`.
- Clicked `End Streaming`; button returned to `Open Streaming`.
- Browser network showed no repeated `/agent/voice/preview` MP3 calls during page load or Open Streaming toggle.
- Full speech E2E still requires a real human microphone session for final spoken utterance, audio playback, and barge-in timing proof.

Verification:

```bash
cd /var/Ghost-chatUI && npm run lint
cd /var/Ghost-chatUI && npm test -- --run
cd /var/Ghost-chatUI && npm run build
cd /var/llamaindex/ghoststack-rag && docker run --rm -e PYTHONPATH=/app/src -v /var/llamaindex/ghoststack-rag/backend:/app -w /app ghoststack-rag-agent-ingress pytest
cd /var/llamaindex/ghoststack-rag && docker compose up -d --build agent-ingress control-api ghost-chatui caddy
```

Results:

- Frontend TypeScript lint passed.
- Full frontend Vitest passed: 20 files, 32 tests.
- Frontend production build passed.
- Full backend pytest passed: 315 tests, 3 existing Qdrant compatibility warnings.
- Docker rebuild/restart passed.
