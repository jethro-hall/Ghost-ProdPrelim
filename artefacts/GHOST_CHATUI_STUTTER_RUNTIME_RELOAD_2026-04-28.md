# Ghost ChatUI Stutter Runtime Reload (Midnight Recovery)

## Operator report

- Voice remained stuttery after prior changes.
- Operator questioned whether page was actually serving latest code.

## What was validated

1. Runtime route check:
   - `Caddyfile` confirms `/ghost_chatui/*` routes to `ghost-chatui:3000` (not `ui:4173`).
2. Container rebuild/restart:
   - Rebuilt and restarted `ghost-chatui`, `ui`, `agent-ingress`, `caddy`.
   - Force-recreated `agent-ingress`.
3. Asset check in running `ghost-chatui` container:
   - `/usr/share/nginx/html/assets/index-JROCneR1.js`
   - `/usr/share/nginx/html/assets/index-sMEZm0Sp.css`

## Root cause discovered

- Some TTS fixes had been applied in `ghoststack-rag/ui` (GhostDASH UI), while the operator page in use was `ghost-chatui` (`/var/Ghost-chatUI`).

## Corrective implementation in live page codebase

- Patched `/var/Ghost-chatUI/src/App.tsx`:
  - Replaced URL-chunk audio queue playback with `AudioContext` scheduling for streamed ElevenLabs chunks.
  - Added decode chain to preserve chunk order and avoid overlap.
  - Added hard stop for active streaming audio sources.
  - Relaxed streaming call startup so missing microphone devices do not hard-fail open streaming.

## Current status

- `ghost-chatui` recreated with latest build output.
- `agent-ingress` healthy after force recreate.
