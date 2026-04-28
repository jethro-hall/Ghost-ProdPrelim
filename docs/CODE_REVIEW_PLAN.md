# Code Review Plan

When implementation code is loaded, review it against this checklist.

## Architecture

- Does `/prod_chatui/` use `route_mode=production_chat`?
- Does Magic Mike resolve as `agent_category=consumer_customer`?
- Are Business/Finance/Odoo blocks excluded from Magic Mike?
- Are public presenter and retail output guard mandatory for production chat?

## Voice

- Is there a dedicated `usePhoneCallConversation` or equivalent controller?
- Are mic, speaker, and call states separate?
- Does Preview/Open Streaming emit `call_init`?
- Does Magic Mike greet first naturally?
- Is final transcript auto-submitted exactly once?
- Are interim transcripts display-only?
- Does selected ElevenLabs voice flow into TTS websocket?
- Is `output_format=pcm_24000` used for low-latency playback?
- Does barge-in stop audio and abort active LLM stream?

## Tools

- Is Odoo disabled for Magic Mike in backend policy, not just prompt?
- Are HubTiger tools available with `HUBTIGER_TOOL_ACCESS=read_only`?
- Are write tools blocked safely in read-only mode?
- Are secrets hidden in admin UI?

## Guardrails

- Does input transcript pass guardrails before runtime?
- Does output pass Warranty Coverage Guard, Retail Output Guard, and PublicResponsePresenter before display/speech?
- Are citations/debug/tool errors stripped in production?

## Tests

- Greeting after simulated Odoo failure must not mention Odoo.
- Warranty process answer must not include unasked warranty coverage durations.
- Voice failure must not break text chat.
- No repeated MP3 preview calls during phone-call mode.

## Red flags

```text
single boolean voiceEnabled
interim transcript submitted as user message
Odoo hidden only by prompt
voice selector local-only and not persisted per agent
raw RAG answer sent directly to TTS
cache key without agent_id/category/runtime version/mode
```
