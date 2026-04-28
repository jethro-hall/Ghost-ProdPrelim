# Acceptance Checklist

## Production runtime

- [ ] `/prod_chatui/` sends or resolves `route_mode=production_chat`.
- [ ] Magic Mike resolves as `consumer_customer`.
- [ ] Magic Mike cannot use Odoo tools.
- [ ] Magic Mike cannot mention Odoo/tool/backend/debug content.
- [ ] Retail Output Guard runs before display.
- [ ] Retail Output Guard runs before speech.
- [ ] PublicResponsePresenter is mandatory for production route.

## Preview / phone-call UX

- [ ] Preview starts a real call session.
- [ ] `call_init` is sent before user speech is required.
- [ ] Magic Mike greets first in natural Ride Electric language.
- [ ] Mic permission is requested on Preview if needed.
- [ ] Speaker AudioContext is unlocked on Preview.
- [ ] Mic enabled/muted icon states are visible.
- [ ] Speaker enabled/muted icon states are visible.
- [ ] Muting mic does not end the call.
- [ ] Muting speaker does not end the call.
- [ ] End Call is the only control that ends the session.

## Transcript handling

- [ ] Interim transcript displays only.
- [ ] Final transcript auto-submits once.
- [ ] Duplicate final transcript is blocked by idempotency.
- [ ] User message is not rendered twice.
- [ ] Assistant audio is tied to assistant turn, not user turn.
- [ ] Endpointing sends within 550-900ms after user stops speaking.

## Audio

- [ ] Selected ElevenLabs voice is visible and persisted per agent.
- [ ] Selected voice ID is sent to backend TTS websocket.
- [ ] TTS uses `eleven_flash_v2_5`.
- [ ] TTS uses `output_format=pcm_24000`.
- [ ] PCM audio chunks reach AudioContext queue.
- [ ] No browser speechSynthesis in production phone-call mode.
- [ ] No repeated MP3 preview calls in phone-call mode.
- [ ] Barge-in stops assistant audio within 150ms target.

## STT

- [ ] Production primary is server streaming STT.
- [ ] Local Docker STT GPU status is verified and documented.
- [ ] STT latency metrics are recorded.
- [ ] Browser STT is fallback only.

## Warranty guard

- [ ] Warranty process answer is short and natural.
- [ ] Warranty process answer does not include unasked coverage terms.
- [ ] Warranty coverage durations require verified source and exact model.
- [ ] Raw manual/RAG warranty summary is not spoken directly.

## Tool admin phase 2

- [ ] Per-agent tool enable/disable exists.
- [ ] HubTiger tools appear in admin.
- [ ] HubTiger read-only test console works.
- [ ] HubTiger write tests are disabled in read-only mode.
- [ ] Secrets are never displayed.
