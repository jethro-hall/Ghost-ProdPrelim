# GhostDash ElevenLabs Flash v2.5 Realtime Voice — Lowest Latency Implementation

## Purpose

This package implements the low-latency path you actually want:

```text
LLM streaming deltas
→ GhostDash backend WebSocket
→ ElevenLabs stream-input WebSocket
→ Flash v2.5
→ PCM audio chunks
→ browser AudioContext playback
```

This is different from the earlier HTTP `/stream` adapter.

The earlier HTTP stream is useful for fallback and admin preview.  
This WebSocket adapter is the production low-latency path for live Magic Mike / GhostDash voice.

---

## Files

```text
ghostdash_elevenlabs_flash25_realtime.py
elevenFlash25RealtimeClient.ts
```

---

## Why this is the best-practice low-latency path

- Uses `eleven_flash_v2_5`.
- Uses ElevenLabs WebSocket `stream-input`.
- Uses `auto_mode: true`.
- Streams LLM deltas as natural clauses.
- Uses PCM output for browser playback.
- Avoids stitched per-sentence MP3 preview calls.
- Supports cancellation/interruption.
- Keeps ElevenLabs API key server-side.
- Captures first text / first audio timing metrics.

---

## Backend route

```text
WebSocket /api/voice/elevenlabs/flash25/realtime
```

Client first sends:

```json
{
  "type": "start",
  "voice_id": "YOUR_VOICE_ID",
  "model_id": "eleven_flash_v2_5",
  "output_format": "pcm_24000",
  "language_code": "en",
  "auto_mode": true,
  "sync_alignment": false,
  "apply_text_normalization": "auto",
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0,
    "use_speaker_boost": true,
    "speed": 1
  }
}
```

Then it sends streaming text:

```json
{ "type": "text_delta", "text": "Yep, let me check" }
```

When done:

```json
{ "type": "finish" }
```

To interrupt:

```json
{ "type": "cancel" }
```

---

## Server responses

Audio chunks:

```json
{
  "type": "audio",
  "audio": "base64-pcm16",
  "format": "pcm_24000",
  "sample_rate_hz": 24000
}
```

Metrics:

```json
{
  "type": "metrics",
  "event": "first_text_sent",
  "metrics": {
    "first_text_sent_ms": 120,
    "first_audio_chunk_ms": 310
  }
}
```

---

## Integration

### FastAPI

```python
from ghostdash_elevenlabs_flash25_realtime import router as elevenlabs_realtime_router

app.include_router(elevenlabs_realtime_router)
```

### Frontend

```ts
const client = new ElevenFlash25RealtimeClient();

await client.connect({
  wsUrl: "wss://ghoststack.rideai.com.au/api/voice/elevenlabs/flash25/realtime",
  voiceId: selectedVoiceId,
  outputFormat: "pcm_24000"
});

llmStream.onDelta((delta) => client.sendDelta(delta));
llmStream.onDone(() => client.finish());
stopButton.onclick = () => client.cancel();
```

---

## Recommended settings

```json
{
  "model_id": "eleven_flash_v2_5",
  "output_format": "pcm_24000",
  "auto_mode": true,
  "sync_alignment": false,
  "apply_text_normalization": "auto",
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0,
    "use_speaker_boost": true,
    "speed": 1.0
  }
}
```

Use `sync_alignment: true` only in admin/lab debugging. It adds payload weight.

Use `ulaw_8000` only for telephony.

Use MP3 only for admin preview or fallback. PCM is better for browser low-latency queue playback.

---

## Acceptance tests

1. First audio starts before the full LLM response is complete.
2. No one-HTTP-request-per-sentence behaviour.
3. Stop/cancel immediately stops current and queued audio.
4. No overlapping playback.
5. Audio sounds continuous, not stitched.
6. `first_text_sent_ms` and `first_audio_chunk_ms` are reported.
7. ElevenLabs API key never appears in browser bundle/network payload.
