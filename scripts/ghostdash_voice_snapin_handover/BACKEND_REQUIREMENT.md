# Backend Requirement

The snap-in expects this backend route:

```text
WS /api/voice/elevenlabs/flash25/realtime
```

It should be implemented by the previously supplied `ghostdash_elevenlabs_flash25_realtime.py`.

FastAPI mount:

```python
from ghostdash_elevenlabs_flash25_realtime import router as elevenlabs_realtime_router

app.include_router(elevenlabs_realtime_router)
```

Environment:

```env
ELEVENLABS_API_KEY=...
```

Recommended backend settings:

```json
{
  "model_id": "eleven_flash_v2_5",
  "output_format": "pcm_24000",
  "auto_mode": true,
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

Do not proxy ElevenLabs directly from the browser.
