# GhostDash Voice Snap-In — Cursor Handover

## Objective

Replace the current broken/jumpy voice controls with a snap-in voice module that:

- records mic/STT reliably enough for GhostChat testing
- shows a live EQ/signal meter so the user knows the mic is working
- streams assistant deltas to ElevenLabs Flash v2.5 through the existing backend WebSocket
- plays PCM chunks through AudioContext for low-latency smooth speech
- does not use per-sentence MP3 preview calls
- supports stop/cancel cleanly
- keeps ElevenLabs API key server-side

## Files to install

```text
src/ghostdashVoiceSnapIn/ghostDashVoiceRealtimeClient.ts
src/ghostdashVoiceSnapIn/useGhostDashVoiceSnapIn.ts
src/ghostdashVoiceSnapIn/GhostDashVoiceSnapIn.tsx
src/ghostdashVoiceSnapIn/ghostDashVoiceSnapIn.css
```

Backend route required:

```text
WS /api/voice/elevenlabs/flash25/realtime
```

If the backend route is not installed yet, use the previously provided:

```text
ghostdash_elevenlabs_flash25_realtime.py
```

## Correct architecture

```text
User mic
→ browser STT transcript
→ GhostChat composer
→ /agent/v1/chat/completions or current GhostDash chat stream
→ assistant text deltas
→ useGhostDashVoiceSnapIn.speakAssistantDelta(delta)
→ backend WS /api/voice/elevenlabs/flash25/realtime
→ ElevenLabs stream-input using eleven_flash_v2_5
→ PCM audio chunks
→ AudioContext playback
```

## Why the current build feels wrong

The UI currently says:

```text
Server-side ElevenLabs realtime proxy is configured but not enabled in this build.
```

That means the visible "Open Streaming" control is not actually opening the realtime path.

Also, if the old path still waits until `onDone` or sends one preview request per sentence, it will:

- speak late
- sound jumpy
- miss first words
- create audio gaps
- fail to prove mic activity

This snap-in fixes that by wiring:
- mic permission
- STT
- live EQ meter
- realtime TTS WebSocket
- cancellation

## Integration example

Inside the chat component or state owner where streaming is handled:

```tsx
import { GhostDashVoiceSnapIn } from "./ghostdashVoiceSnapIn/GhostDashVoiceSnapIn";
import { useGhostDashVoiceSnapIn } from "./ghostdashVoiceSnapIn/useGhostDashVoiceSnapIn";

const [speakResponses, setSpeakResponses] = useState(true);
const [composerText, setComposerText] = useState("");

const voice = useGhostDashVoiceSnapIn({
  ttsWsUrl: "wss://ghoststack.rideai.com.au/api/voice/elevenlabs/flash25/realtime",
  voiceId: selectedElevenLabsVoiceId,
  enabled: speakResponses,
  languageCode: "en-AU",
  onTranscriptFinal: (text) => {
    setComposerText((current) => current ? `${current} ${text}` : text);
  },
  onError: (message) => {
    console.warn(message);
  },
  voiceSettings: {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    use_speaker_boost: true,
    speed: 1
  },
  customReplacements: [
    { key: "VSETT", value: "V-set" },
    { key: "Fatfish", value: "Fat Fish" }
  ]
});
```

Render it near the composer controls:

```tsx
<GhostDashVoiceSnapIn
  voice={voice}
  speakResponses={speakResponses}
  onSpeakResponsesChange={setSpeakResponses}
/>
```

## Required streaming hook points

When the user sends a message, preconnect TTS before deltas arrive:

```ts
await voice.prepareAssistantSpeech({
  previousText: userMessageText
});
```

When assistant stream emits a delta:

```ts
voice.speakAssistantDelta(deltaText);
```

When assistant stream completes:

```ts
voice.finishAssistantSpeech();
```

When user clicks Stop Generating / Stop Speaking:

```ts
voice.stopSpeaking();
```

When user clicks mic:

```ts
voice.startDictation();
```

## Where to wire in GhostChat

Cursor must inspect current code first, but likely locations are:

```text
Ghost-chatUI/src/lib/state/useGhostChat.ts
Ghost-chatUI/src/components/chat/Composer.tsx
Ghost-chatUI/src/components/chat/ChatHeader.tsx
Ghost-chatUI/src/App.tsx
```

Do not duplicate chat state.

Do not create a second chat API.

Do not expose API keys to frontend.

## Acceptance tests

Manual tests:

1. Click mic. Browser asks for permission.
2. Speak into mic. EQ bars move.
3. Transcript appears or goes into composer.
4. Send message.
5. Assistant starts speaking before the full text response finishes.
6. Stop Speaking immediately stops audio.
7. Stop Generating also stops audio.
8. No overlapping audio on regenerate.
9. No "configured but not enabled" banner remains if route is active.
10. Network shows one backend WS connection for TTS, not one HTTP MP3 request per sentence.

Unit tests to add where practical:

```text
useGhostDashVoiceSnapIn defaults idle
startDictation handles missing Web Speech API safely
stopSpeaking calls cancel
speakAssistantDelta does nothing when disabled
GhostDashVoiceSnapIn renders EQ bars
```

## Important limitation

Browser SpeechRecognition is available in Chromium browsers but not all browsers.

For production phone calls, STT should be owned by ElevenLabs/Twilio or a dedicated backend STT provider.

For GhostChat UI testing, this snap-in is good enough and fast.
