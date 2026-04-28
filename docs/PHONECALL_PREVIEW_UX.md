# Phone-Call Preview UX Specification

## Purpose

Preview/Open Streaming must behave like a real phone call, not like a dictation box.

The user clicks once and the system starts a live call session.

```text
Preview click
→ microphone permission requested if needed
→ microphone enabled
→ speaker AudioContext unlocked
→ selected ElevenLabs voice resolved
→ call_init sent to Magic Mike
→ Magic Mike greets first
→ user speaks naturally
→ final transcript auto-sends
→ Magic Mike responds with text + audio
→ user can interrupt by speaking
```

## Required call initiation

Add a dedicated event:

```ts
type CallInitiationEvent = {
  type: "call_init";
  agent_id: "magic_mike";
  route_mode: "production_chat" | "agent_lab_preview";
  channel: "voice_preview" | "phone_call";
  local_time: string;
  timezone: "Australia/Brisbane";
};
```

Magic Mike must answer the call naturally:

```text
Morning, I’m Mike from Ride Electric. How are you?
```

or:

```text
Afternoon, you’re speaking with Mike at Ride Electric. What can I help you with?
```

No tool calls for `call_init`.
No Odoo.
No citations/debug.
No generic AI assistant phrasing.

## Independent state

Do not use a single `voiceEnabled` boolean.

Use independent state:

```ts
type MicState = "permission_needed" | "enabled" | "muted" | "error";
type SpeakerState = "enabled" | "muted" | "error";
type CallState =
  | "closed"
  | "opening"
  | "greeting"
  | "listening"
  | "user_speaking"
  | "endpointing"
  | "submitting_user_turn"
  | "assistant_thinking"
  | "assistant_speaking"
  | "barge_in"
  | "stopping"
  | "error";
```

Mic mute must not close the call.
Speaker mute must not close the call.
Only End Call closes the call.

## Icon UX

Microphone:

```text
mic_enabled: active blue microphone icon
mic_muted: microphone icon with diagonal slash
mic_permission_needed: neutral/warning microphone icon
mic_error: error microphone icon
```

Speaker:

```text
speaker_enabled: active speaker icon
speaker_muted: speaker icon with diagonal slash
speaker_error: error speaker icon
```

## Transcript behaviour

Interim transcript:

```text
display only
never submit
```

Final transcript:

```text
auto-submit exactly once
must have turn_id
must have idempotency key
must pass input guardrails before runtime
```

## Idempotency

Use a key like:

```ts
const utteranceKey = sha256([
  sessionId,
  agentId,
  normalizedFinalTranscript,
  sttFinalTimestampBucket,
].join(":"));
```

If the same key has already been submitted, drop it.

## Ordering rule

```text
call_init creates call greeting turn
user final transcript creates one user turn
assistant response creates assistant turn
audio attaches to assistant turn only
```

Never attach assistant audio to a user turn.
Never replay stale audio when starting a new preview session.
