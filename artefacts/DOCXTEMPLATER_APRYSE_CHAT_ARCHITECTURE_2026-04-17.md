# DOCXTEMPLATER + APRYSE CHAT ARCHITECTURE (2026-04-17)

## Scope Delivered

- Added Apryse WebViewer panel integration to chat with a session-level `Apryse Docs` toggle.
- Extended chat API request/response contracts with `docx_mode`, `docx_artifacts`, and `docx_diagnostics`.
- Added doc-mode ingress behavior that preserves per-request `llm_model_id` override and enforces finalize validation.
- Added a dedicated Node sidecar service at `stack/docx-templater` with preview/finalize endpoints.
- Added doc session persistence (`docx_sessions`) to retain template operation state and sidecar outputs.

## Runtime Flow

1. User enables `Apryse Docs` and sends chat message.
2. UI includes `docx_mode` in stream payload.
3. Agent ingress applies doc-mode directives (fixed behavior path) while still using `_effective_chat_model_id(...)`.
4. Ingress calls `docx-templater` sidecar (`/render/preview` or `/render/finalize`).
5. Sidecar returns artifacts/diagnostics.
6. Ingress persists state to `docx_sessions` and streams diagnostics/artifacts back to UI.

## Service Boundaries

- Browser -> `ui` only.
- Browser -> `/api/*` and `/agent/*` only.
- `agent-ingress` -> `docx-templater` internal HTTP.
- No direct browser access to sidecar.

## Data Persistence

`docx_sessions` table stores:

- `conversation_id`
- `agent_id`
- `template_id`
- `operation`
- `status`
- `binding_json`
- `artifacts_json`
- `diagnostics_json`

## Validation and Failure Handling

- `operation=finalize` without `template_id` returns `HTTP 400`.
- Sidecar unavailable/error returns normalized diagnostic code:
  - `docx_sidecar_unavailable`
  - `docx_sidecar_error`
- Chat still completes with assistant response even when sidecar diagnostics are present.

## Human Test Checklist

- [ ] Toggle `Apryse Docs` on/off in composer and confirm panel visibility behavior.
- [ ] Verify missing `VITE_APRYSE_LICENSE_KEY` shows warning state, not crash.
- [ ] Send `preview` operation and confirm artifacts/diagnostics appear in stream done payload.
- [ ] Send `finalize` without template id and confirm explicit `400`.
- [ ] Send `finalize` with template id and verify persisted `docx_sessions` row updates.
- [ ] Reload session and confirm doc-mode state can continue from persisted conversation context.

## Findings / Fix Log

- **Issue:** Local `pnpm` was unavailable and host `node_modules` permissions prevented direct install.
  - **Fix:** Installed `@pdftron/webviewer` via containerized pnpm against existing store layout.
- **Issue:** Diagnostic scripts referenced stale external container names.
  - **Fix:** Use active containers in this stack: `ghoststack-rag-caddy-1`, `ghoststack-rag-control-api-1`, and `ghoststack-rag-agent-ingress-1`.

