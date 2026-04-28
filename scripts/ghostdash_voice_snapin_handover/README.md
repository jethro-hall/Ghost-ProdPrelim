# GhostDash Voice Snap-In Package

This is a drop-in package for Cursor to install into GhostChat UI.

## Included

```text
src/ghostdashVoiceSnapIn/ghostDashVoiceRealtimeClient.ts
src/ghostdashVoiceSnapIn/useGhostDashVoiceSnapIn.ts
src/ghostdashVoiceSnapIn/GhostDashVoiceSnapIn.tsx
src/ghostdashVoiceSnapIn/ghostDashVoiceSnapIn.css
CURSOR_HANDOVER.md
BACKEND_REQUIREMENT.md
README.md
```

## What it fixes

- Current realtime proxy says configured but not enabled.
- Mic does not clearly show it is recording.
- No EQ/signal meter.
- Audio path can be late or jumpy.
- Stop speaking/generation can leave queued audio.
- Browser TTS and per-sentence MP3 preview are not suitable for production feel.

## Correct path

```text
browser mic/STT
→ composer
→ GhostDash LLM stream
→ assistant delta
→ backend ElevenLabs Flash v2.5 realtime websocket
→ PCM chunks
→ AudioContext queue
```

## Cursor instruction

Open `CURSOR_HANDOVER.md` and follow it exactly.
