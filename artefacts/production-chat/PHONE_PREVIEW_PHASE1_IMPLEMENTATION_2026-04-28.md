# GhostDash Phone Preview Phase 1 Implementation (2026-04-28)

## Scope executed
- Implemented Phase 1 call-preview lifecycle foundation for `/prod_chatui/` and aligned `/ghost_chatui/` preview kickoff with call-init semantics.
- Added turn metadata (`turn_id`, `turn_type`, `utterance_key`) and `call_init` payload wiring frontend->backend.
- Added endpointing/idempotency behavior in phone controller with default target `650ms` and max `900ms`.
- Added server voice provider health endpoint (`/agent/voice/health`) with Deepgram-primary config surface and fallback metadata.
- Hardened Magic Mike/Odoo tool policy enforcement for consumer category.
- Extended admin Agent Config with Phase 1 tool visibility cues (HubTiger visibility rows + Magic Mike Odoo disabled badge).

## Root-cause notes addressed
- Preview/Open Streaming previously toggled voice flags but did not consistently start a true call lifecycle with explicit call-init semantics.
- Mic/speaker states were coupled to generic voice state and not exposed as independent controls.
- Final transcript submissions could duplicate under rapid stop/start or repeated final events.
- Tool policy mutation path accepted narrow allowlist behavior and did not centrally enforce category-level finance-tool denial.

## Files changed (Phase 1 implementation)
- `/var/Ghost-chatUI/src/lib/voice/usePhoneCallConversation.ts` (new)
- `/var/Ghost-chatUI/src/lib/types/chat.ts`
- `/var/Ghost-chatUI/src/lib/providers/api.ts`
- `/var/Ghost-chatUI/src/lib/state/useGhostChat.ts`
- `/var/Ghost-chatUI/src/pages/ProductionChatPage.tsx`
- `/var/Ghost-chatUI/src/ghostdashVoiceSnapIn/GhostDashVoiceSnapIn.tsx`
- `/var/Ghost-chatUI/src/ghostdashVoiceSnapIn/ghostDashVoiceSnapIn.css`
- `/var/Ghost-chatUI/src/ghostdashVoiceSnapIn/ghostDashVoiceRealtimeClient.ts`
- `/var/Ghost-chatUI/src/ghostdashVoiceSnapIn/useGhostDashVoiceSnapIn.ts`
- `/var/Ghost-chatUI/src/App.tsx`
- `/var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/schemas.py`
- `/var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/agent_ingress.py`
- `/var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/voice_ingress.py`
- `/var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/tool_registry.py`
- `/var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/magic_mike.py`
- `/var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/settings.py`
- `/var/llamaindex/ghoststack-rag/ui/src/pages/AgentConfigPage.tsx`
- `/var/llamaindex/ghoststack-rag/.env.example`

## Verification executed
- Frontend (`/var/Ghost-chatUI`)
  - `npm run build` -> passed.
  - `npm test` -> passed (`35 passed`).
- Backend (`/var/llamaindex/ghoststack-rag/backend`)
  - `pytest -q tests/test_agent_ingress_public_stream.py tests/test_public_response_presenter.py tests/test_agent_ingress_voice_openai_compat.py` -> passed (`24 passed`).
- Runtime API proofs
  - `curl -sS http://127.0.0.1/agent/voice/health` ->
    - `stt_provider=deepgram_primary`
    - `stt.endpointing_ms=650`
    - `stt.max_endpointing_ms=900`
    - `tts.output_format=pcm_24000`
  - `curl -sS "http://127.0.0.1/api/chat/bootstrap?surface=prod_chatui"` ->
    - `default_agent_name=Magic Mike`
  - `curl -sS http://127.0.0.1/api/tools/policy/d0cbb7e2-45cd-4605-bc01-fb860c7f7531` ->
    - `allowed_tool_ids=["kb","web"]`
  - `curl -sS http://127.0.0.1/api/tools/catalog` ->
    - `[]` (legacy Odoo public catalog retired)

## Additional checks
- Diagnose-first commands executed:
  - `git status -sb`
  - `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
  - `docker logs --tail=120 ghost-edge-gateway` (container alias absent in this stack)
  - `docker logs --tail=120 ghost-control-plane` (container alias absent in this stack)
- Admin UI build command currently blocked by file-permission issue in existing `ui/dist` output path:
  - `EACCES: permission denied, unlink .../ui/dist/assets/index-*.css`

## Human E2E checklist (required)
- Open `/prod_chatui/`.
- In voice controls:
  - Click `Preview`; confirm immediate assistant greeting turn appears without pressing Send.
  - Confirm mic and speaker toggles work independently and do not end the call.
  - Speak one utterance; confirm interim transcript displays but only one final user submit occurs.
  - Speak during assistant audio; confirm barge-in stops speaking and resumes listening.
  - Mute speaker; confirm text continues and call remains open.
  - End call; confirm session closes and transcript state resets.
- Open `/ghost_chatui/`:
  - Trigger call preview and confirm call-init greeting behavior remains available.
- Open Agent Config for Magic Mike:
  - Confirm Odoo disabled badge is present.
  - Confirm HubTiger visibility rows are present in Tools area.

## Remaining operator actions
- Fix ownership/permissions on `/var/llamaindex/ghoststack-rag/ui/dist` to restore admin UI production build command.
- Perform browser-based human E2E with audible verification and capture screenshots/traces.
