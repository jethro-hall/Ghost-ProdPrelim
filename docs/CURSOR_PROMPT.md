# Cursor Prompt

Paste this into Cursor for the first implementation pass.

```text
You are working on GhostDash / Magic Mike production rebuild.

This is Phase 1 only. Do not expand into the full admin Tool Settings and HubTiger console unless needed to unblock the call flow.

Objective:
Make Preview/Open Streaming behave like a real phone call for Magic Mike, while hard-disabling Odoo for Magic Mike and enforcing guardrails before display/speech.

Required:
1. Create a dedicated phone-call/preview controller, preferably usePhoneCallConversation.
2. Implement call_init event so Magic Mike greets first like a real Ride Electric phone agent.
3. Keep mic state, speaker state, and call state independent.
4. Add mic enabled/muted and speaker enabled/muted icon states.
5. Muting mic or speaker must not end the call.
6. Final transcript auto-submits exactly once without pressing Send.
7. Interim transcript displays only and never submits.
8. Add turn_id + utterance idempotency to prevent duplicated user text.
9. Attach assistant audio only to assistant turns.
10. Tune endpointing/debounce to 550-900ms after the user stops speaking.
11. Resolve and persist selected ElevenLabs voice per agent.
12. Use ElevenLabs Flash v2.5 realtime TTS via backend websocket only.
13. Use output_format=pcm_24000 and AudioContext PCM playback.
14. Implement barge-in: user speech during assistant_speaking stops audio, aborts active LLM stream, and keeps mic open.
15. Run final transcript through input guardrails before Magic Mike runtime.
16. Run output through Warranty Coverage Guard, Retail Output Guard, and PublicResponsePresenter before display and speech.
17. Magic Mike in /prod_chatui must be consumer_customer, route_mode=production_chat, diagnostics_visible=false.
18. Magic Mike must not use or mention Odoo.
19. Verify server streaming STT is primary; browser/local STT is fallback.
20. Verify local STT Docker GPU status and document results.

Provide proof:
- files changed
- state machine implementation
- before/after Magic Mike greeting
- network proof of one TTS websocket and no repeated MP3 preview calls
- voice selector screenshot
- audio metrics
- duplicate transcript regression test
- STT latency and GPU verification
- Odoo disabled for Magic Mike in backend policy
```
