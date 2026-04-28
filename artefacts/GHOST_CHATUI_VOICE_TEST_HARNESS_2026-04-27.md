# Ghost ChatUI Voice Test Harness

Date: 2026-04-27

## Purpose

Ghost ChatUI now has a phased voice testing harness for Magic Mike and other GhostDASH agents. Phase 1 uses browser-native speech APIs around the existing `/agent/chat/stream` path. Phase 2 keeps ElevenLabs server-side through `agent-ingress` for voice listing and realtime streaming.

## Browser-Native Phase

- Mic dictation uses the browser `SpeechRecognition` or `webkitSpeechRecognition` API when available.
- Recognized speech is inserted into the normal GhostChat composer; it is not auto-sent.
- Spoken assistant responses use browser `speechSynthesis` and speak only final assistant text, not tool traces or telemetry.
- Operators can stop speech output.
- Unsupported browsers show disabled controls and keep text chat usable.

## ElevenLabs Phase

- `GET /agent/voice/voices` returns normalized ElevenLabs voice availability without exposing API keys.
- `POST /agent/voice/preview` fails closed until server-side audio preview is implemented.
- `WS /agent/voice/stream` fails closed when ElevenLabs is not configured and logs terminal state.
- Realtime audio proxying remains server-owned by `agent-ingress`; the browser must never call ElevenLabs directly.

## Environment Variables

```text
ELEVENLABS_API_KEY=
ELEVENLABS_DEFAULT_VOICE_ID=
ELEVENLABS_ALLOWED_VOICE_IDS=
```

`ELEVENLABS_ALLOWED_VOICE_IDS` is a comma-separated allowlist. Leave it empty only if all workspace voices are acceptable for testing.

## Acceptance Criteria

- Operator can press `Mic`, speak a question, and see transcript text populate the composer.
- Operator can send the transcript through existing GhostChat streaming.
- Assistant response can be spoken aloud and stopped.
- Browser voice selector lists local synthesis voices when supported.
- ElevenLabs selector shows configured or unconfigured state without exposing secrets.
- `Open Streaming` opens a call panel and shows the backend unconfigured/error state cleanly.
- Closing the call stops mic tracks and closes the WebSocket.

## Human QA Script

1. Open `https://ghoststack.rideai.com.au/ghost_chatui/`.
2. Select `Magic Mike`.
3. Open Chat tools and enable `Speak response`.
4. Press `Mic` and say: “What is the battery size for the Fatfish OG 2.0?”
5. Confirm the transcript appears in the composer before sending.
6. Send the message and confirm the response is spoken once.
7. Press `Stop speaking` and confirm audio stops immediately.
8. Press `Open Streaming` and confirm either an unconfigured state or a live call panel appears.
9. Press `End call` and confirm the browser mic indicator turns off.

## Verify Commands

```bash
python3.12 -m compileall backend/src
python3.12 -m pytest backend/tests/test_agent_ingress_voice_openai_compat.py -q
docker compose config
docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"
```
