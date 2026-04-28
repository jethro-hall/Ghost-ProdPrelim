# Voice STT/TTS Runtime Specification

## Runtime goal

Production phone-call mode must use a low-latency streaming pipeline:

```text
mic audio
→ streaming STT
→ final transcript endpointing
→ input guardrails
→ Magic Mike runtime
→ safe text deltas
→ ElevenLabs Flash v2.5 realtime TTS
→ PCM AudioContext playback
```

## STT primary

Production primary:

```text
server-side streaming STT, preferably Deepgram Nova or equivalent
```

Browser SpeechRecognition is fallback only.
Local Docker GPU STT is fallback/future cost optimisation unless proven faster and equally reliable.

## STT endpointing targets

```text
User stops speaking → auto-submit within 550-900ms
Audio frame size: 20ms
Sample rate: 16000 Hz
Encoding: pcm_s16le
Min utterance chars: 2
Max user turn: 15000ms
```

Do not wait for perfect punctuation.
Do not submit every interim partial.

## STT GPU verification

When local STT exists, prove whether it is running on GPU.

Commands:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' | grep -Ei 'stt|speech|whisper|faster|deepgram|asr|voice'
docker compose config | grep -Ei 'stt|speech|whisper|faster|asr|gpu|nvidia|deploy|devices|runtime'
nvidia-smi
docker info | grep -i nvidia || true
docker inspect <stt_container_name> | grep -Ei 'nvidia|gpu|device|runtime|capabilities' -n
docker exec -it <stt_container_name> nvidia-smi
```

If PyTorch based:

```bash
docker exec -it <stt_container_name> python - <<'PY'
import torch
print('cuda_available=', torch.cuda.is_available())
print('device_count=', torch.cuda.device_count())
if torch.cuda.is_available():
    print('device=', torch.cuda.get_device_name(0))
PY
```

Document:

```text
model name
model size
device: cuda or cpu
compute type
batch size
audio frame size
sample rate
endpointing ms
first interim latency
final transcript latency
GPU memory
CPU usage
```

## TTS provider

Use ElevenLabs Flash v2.5 realtime via backend websocket.

```text
model_id: eleven_flash_v2_5
output_format: pcm_24000
auto_mode: true
```

No browser speechSynthesis.
No per-sentence MP3 preview calls in phone-call mode.
No direct browser calls to ElevenLabs API.

## Required TTS lifecycle

```ts
onCallStart:
  unlock AudioContext
  resolve selected voice_id

onUserTurnAutoSubmit:
  prepareAssistantSpeech()

onAssistantDelta:
  speakAssistantDelta(delta)

onAssistantDone:
  finishAssistantSpeech()

onBargeIn:
  stopSpeaking()
  abort active LLM stream
  close/cancel current TTS stream
```

## Audio proof metrics

Capture:

```ts
type VoicePlaybackMetrics = {
  voiceId: string | null;
  ttsConnected: boolean;
  firstTextSentMs?: number;
  firstAudioChunkMs?: number;
  audioChunksReceived: number;
  audioBytesReceived: number;
  audioContextState: AudioContextState | 'unknown';
  outputFormat: string;
};
```

## Latency targets

```text
Mic to interim transcript: < 350ms
Endpoint after silence: 550-900ms
Final transcript to first LLM delta: < 700ms
First assistant delta to first audio chunk: < 500ms
Total perceived response after user stops: 900-1600ms
Barge-in stop audio: < 150ms
```
