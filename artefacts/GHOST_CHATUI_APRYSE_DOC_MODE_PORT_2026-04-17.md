# Ghost ChatUI Apryse Doc Mode Port (2026-04-17)

## Scope

Port Apryse/Docxtemplater chat controls from the main GhostDASH chat surface into the `ghost_chatui` surface (`/ghost_chatui/`) so operators can enable doc mode in the same UI they use day-to-day.

## Files Updated

- `/var/Ghost-chatUI/src/lib/types/chat.ts`
  - Added `DocxOperation`, `ChatDocxMode`, `DocxArtifact`, `DocxDiagnostic`
  - Extended stream payload types to include `docx_artifacts` and `docx_diagnostics`
  - Extended `ChatRequestArgs` with `docxMode`
- `/var/Ghost-chatUI/src/lib/providers/api.ts`
  - Sends `docx_mode` payload to `/agent/chat/stream`
  - Parses `docx_artifacts` and `docx_diagnostics` on `start` and `done` events
- `/var/Ghost-chatUI/src/lib/state/useGhostChat.ts`
  - Added `sessionDocxMode`, `docxArtifacts`, `docxDiagnostics` state
  - Propagates `docxMode` into stream requests
  - Hydrates artifacts/diagnostics from stream payloads
  - Resets docx state when switching/newing conversations
- `/var/Ghost-chatUI/src/components/chat/Composer.tsx`
  - Added `Apryse Docs On/Off` toggle
  - Added `Preview/Finalize` selector and `Template ID` field
  - Added artifacts/diagnostics strip (artifact links + diagnostics messages)
- `/var/Ghost-chatUI/src/App.tsx`
  - Wired doc mode state/handlers into `Composer`

## Human Test (Browser, Real Surface)

Surface tested: `https://ghoststack.rideai.com.au/ghost_chatui/`

Results:

1. `Apryse Docs Off` control is visible in the composer.
2. Clicking toggle switches to `Apryse Docs On`.
3. `Preview` selector and `Template ID` input render.
4. Stream request is sent with doc mode options.

Evidence screenshot captured:

- `human-test-ghost-chatui-apryse-toggle-on.png`

## Runtime Verification

Validated backend doc mode response contract after the port:

- `/agent/chat` request with `docx_mode.enabled=true` returned:
  - `tool_events` containing `apryse_docs` planned operation
  - non-empty `docx_artifacts`
  - `docx_diagnostics` array

## Notes / Risks

- During one browser send attempt, UI displayed provider error banner. Agent ingress logs show a `400` on one stream request, while independent doc mode API verification returned expected artifacts. This indicates the doc mode port is wired, but there may still be intermittent upstream request-shape/content issues unrelated to control visibility.
