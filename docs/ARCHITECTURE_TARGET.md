# Architecture Target

## Target runtime split

```text
/prod_chatui
  clean production surface
  diagnostics forbidden
  public presenter required
  retail output guard required
  consumer customer runtime for Magic Mike

/ghost_chatui
  Agent Lab / testing surface
  diagnostics allowed
  trace panels allowed
  prompt/runtime inspection allowed
```

## Target phone-call flow

```text
Preview / Start Call
→ request mic permission
→ unlock AudioContext
→ start EQ/VAD
→ resolve selected ElevenLabs voice
→ send call_init
→ Magic Mike greets first
→ user speaks
→ interim transcript displays only
→ final transcript auto-submits once
→ input guardrails
→ Magic Mike runtime
→ output guards
→ safe display text
→ ElevenLabs Flash v2.5 realtime TTS
→ PCM AudioContext playback
→ barge-in keeps the call natural
```

## Required controller

Create a dedicated controller such as:

```text
usePhoneCallConversation
```

It owns:

```text
call state machine
mic lifecycle
speaker lifecycle
STT lifecycle
endpointing/debounce
turn id and idempotency
LLM stream start/abort
TTS websocket lifecycle
barge-in
cleanup
```

Do not hide this state machine inside a button or generic component.

## Required state model

```ts
type PreviewCallState =
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

type MicState =
  | "permission_needed"
  | "enabled"
  | "muted"
  | "error";

type SpeakerState =
  | "enabled"
  | "muted"
  | "error";
```

Mic and speaker states are independent from call state.

## LLM routing

Magic Mike production runtime:

```json
{
  "agent_id": "magic_mike",
  "agent_category": "consumer_customer",
  "route_mode": "production_chat",
  "public_presenter_required": true,
  "retail_output_guard_required": true,
  "diagnostics_visible": false
}
```

Forbidden in Magic Mike output:

```text
Odoo
tool blocked
backend
orchestrator
citations
scorecard
Execution Truth
Source mode
semantic
structured
provided documents
grounded information
database
```

## TTS requirements

```text
provider: ElevenLabs
model_id: eleven_flash_v2_5
transport: backend WebSocket only
output_format: pcm_24000
browser playback: AudioContext PCM queue
```

No browser speechSynthesis.
No repeated MP3 preview calls in phone-call mode.
No direct browser calls to ElevenLabs API.
