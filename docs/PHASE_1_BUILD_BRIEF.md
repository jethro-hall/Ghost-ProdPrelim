# Phase 1 Build Brief

## Goal

Make Magic Mike production chat and phone-call preview usable before building wider admin tooling.

Phase 1 fixes the customer-facing path only:

```text
/prod_chatui
→ Magic Mike consumer_customer runtime
→ guarded input
→ clean production response
→ ElevenLabs selected voice output
→ true phone-call interaction
```

## Phase 1 scope

Build only these items now:

1. Dedicated preview/phone-call controller.
2. `call_init` event so Magic Mike greets first like a real Ride Electric phone agent.
3. Independent mic, speaker, and call state.
4. Mic enabled/muted and speaker enabled/muted icon UX.
5. Final transcript auto-submit without pressing Send.
6. Turn ID and utterance idempotency to prevent duplicate user messages.
7. Assistant audio attached to assistant turn only.
8. Endpointing/debounce tuned to 550-900ms.
9. Selected ElevenLabs voice resolved and used.
10. Barge-in: user speech stops assistant audio and active LLM stream.
11. Transcript passes input guardrails before runtime.
12. Retail Output Guard and PublicResponsePresenter before display and speech.
13. Odoo hard-disabled for Magic Mike.

## Explicitly out of Phase 1

These are Phase 2 unless required to unblock Phase 1:

```text
full Tool Settings admin redesign
full HubTiger admin console
multi-agent analytics UI
long-term LiveKit migration
local GPU STT as primary production dependency
```

## STT choice

Production primary:

```text
server streaming STT, preferably Deepgram/Nova or equivalent
```

Fallback:

```text
browser SpeechRecognition or local Docker GPU STT only if production STT unavailable
```

The local Docker STT container must still be verified for GPU support and documented, but it is not the production primary unless it proves lower latency and equal reliability.

## Hard acceptance

```text
Preview/Open Streaming starts a real call.
Magic Mike receives call_init and greets first.
Mic and speaker have independent enabled/muted states.
Muting mic or speaker does not end the call.
Final transcript auto-submits exactly once.
Interim transcript never submits.
Assistant audio is attached only to assistant turns.
Selected ElevenLabs voice is used.
Barge-in stops audio and active stream.
Transcript passes guardrails before runtime.
Magic Mike cannot use or mention Odoo.
```