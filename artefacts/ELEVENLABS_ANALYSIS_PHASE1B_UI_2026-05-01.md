# ElevenLabs Analysis - Phase 1B UI

Date: 2026-05-01  
Status: Implemented + deployed (UI route and dashboard shell)

## 1) Requirement

Deliver a GhostDASH dashboard page for ElevenLabs analysis in the same project style:

- list + detail inspection flow
- transcript view
- metadata rail behavior
- GhostDASH glass layout and navigation
- wired to `/api/elevenlabs/analysis/*`

## 2) Files changed

- `ui/src/pages/ElevenLabsAnalysisPage.tsx` (new)
- `ui/src/App.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/components/Header.tsx`
- `ui/src/components/AppLayout.tsx`
- `ui/src/api.ts`
- `ui/src/pages/ToolsPage.tsx` (type correction needed for existing lint failure)

## 3) Architecture impact

- Added SPA routes:
  - `/analysis/elevenlabs`
  - `/analysis/elevenlabs/:conversationId`
- Added sidebar entry under QA section: **Voice Analysis**
- Added API client calls for:
  - list, detail, transcript, health
  - audio URL builder for inline playback
- Preserved API boundary (`/api/*` only).

## 4) UI behavior implemented

- Command bar with search + status + date filters
- Conversation list table with status badges
- Detail panel with:
  - header and conversation id
  - audio player (or unavailable message)
  - tabs: overview, transcription, client data, phone call
- Degraded upstream state rendering:
  - warning banner from health/list response
  - empty-state handling when upstream is unavailable

## 5) Tests run

### UI lint + build

```bash
docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"
```

Result: passed.

### Deployment

```bash
docker compose up -d --build ui
```

Result: passed; `ui` container recreated and healthy startup path completed.

## 6) Remote verification (true domain)

- `GET https://ghoststack.rideai.com.au/analysis/elevenlabs` -> `200`
- `GET https://ghoststack.rideai.com.au/api/elevenlabs/analysis/conversations?limit=1` -> `200` degraded payload with:
  - `upstream_ready=false`
  - `warning_code=elevenlabs_invalid_api_key`
  - `items=[]`

## 7) Manual human QA checklist

1. Open `https://ghoststack.rideai.com.au/analysis/elevenlabs`.
2. Confirm sidebar navigation and page header/title.
3. Verify search/status/date controls update results after Refresh.
4. Click a conversation row (when data available) and verify:
   - detail tab values
   - transcript tab rendering
   - audio player fallback behavior
5. Verify degraded warning banner appears when upstream key is invalid.

## 8) Known risks

1. Real conversation content remains blocked by production ElevenLabs key authorization issue (`elevenlabs_invalid_api_key`).
2. UI currently validates degraded mode and empty states; full visual parity with rich production records requires valid upstream data.

## 9) Next step

- Fix production ElevenLabs API credential/scope for ConvAI conversations.
- Re-run human QA with real records and polish IA parity details (phase 1C style pass).
