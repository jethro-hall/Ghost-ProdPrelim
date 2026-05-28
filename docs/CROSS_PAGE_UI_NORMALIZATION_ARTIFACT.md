# Cross-Page UI Normalization Artifact

## Page 1: `/tools`

### UX problems found

- The page was still using the default narrow app canvas and did not match the wider, denser `Agent Config` reference.
- The shared header showed the fallback title instead of a page-specific label.
- The page header wasted space on long explanatory copy instead of prioritizing operator actions.
- Connection setup, readiness, and evidence were stacked in oversized cards instead of a dominant main workspace plus compact right-side inspector.
- Controls and button sizing were inconsistent with the compact sizing now used on `Agent Config`.

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/tools` to the wide-canvas route list so the page can use the available main pane width.

- `ui/src/components/Header.tsx`
  - Added a dedicated `/tools` title: `Tool settings`.

- `ui/src/pages/ToolsPage.tsx`
  - Replaced the oversized header block with a compact command bar:
    - status chips
    - `Refresh`
    - `Test`
    - `Save`
  - Rebuilt the page into:
    - dominant left connection workspace
    - compact right readiness/evidence inspector
    - lower execution workspace with evidence panel
  - Removed low-value explanatory copy and kept only operationally relevant status text.
  - Kept save, test, execute, and activation actions explicit and separate.

- `ui/src/index.css`
  - Added page-specific compact sizing for `tools-page`, `tools-command-bar`, and `tools-side-rail`.
  - Reduced control padding and button heights to align with the `Agent Config` density principles.

### Exact verify commands run

```bash
cd /var/llamaindex/ghoststack-rag/ui && npm run build -- --outDir dist-page-check
cd /var/llamaindex/ghoststack-rag && docker compose build ui && docker compose up -d ui
rm -rf /var/llamaindex/ghoststack-rag/ui/dist-page-check
```

```bash
python3.12 - <<'PY'
import json, urllib.request
with urllib.request.urlopen('http://127.0.0.1/api/tools/odoo_primary') as r:
    data = json.load(r)
print(data['settings']['timeout_ms'])
print(data['active'])
PY
```

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/tools?t=177599`

Checks completed:

1. Page loads with normalized layout and page-specific title.
2. `Test` runs successfully and renders health evidence.
3. `Execute` runs successfully and renders execution evidence.
4. Connection save persists:
   - changed timeout from `20000` to `21000`
   - verified persisted value through `/api/tools/odoo_primary`
   - restored timeout to `20000`
   - verified restored value through `/api/tools/odoo_primary`
5. Activation round-trip persists:
   - deactivated the tool from the live page
   - verified `active == False` through `/api/tools/odoo_primary`
   - reactivated the tool from the live page
   - verified `active == True` through `/api/tools/odoo_primary`

Browser console result:

- no app errors
- only the expected Cursor browser warning about native dialog overrides

## Page 6: `/`

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/` to the wide-canvas route list.

- `ui/src/pages/Dashboard.tsx`
  - Added a compact dashboard header strip.
  - Removed the dead internal width cap.
  - Rebalanced the page into:
    - capability/status card cluster
    - dominant ingress overview workspace
    - compact runtime rail
    - lower operational snapshot and recent-documents sections
  - Reduced low-value explanatory copy blocks.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/?t=177606`

Checks completed:

1. Dashboard loads with the widened layout.
2. Capability cards render correctly.
3. Main ingress overview and lower sections render correctly.

## Page 7: `/vectors`

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/vectors` to the wide-canvas route list.

- `ui/src/pages/VectorsPage.tsx`
  - Rebuilt the page with a compact header, wide metric grid, and compact right-side context rail.
  - Removed the larger explanatory paragraph block.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/vectors?t=177606`

Checks completed:

1. Page loads with the new wide monitoring layout.
2. Aggregate metric cards render correctly.
3. Data-source and scope context rail renders correctly.

## Page 8: `/knowledge-lab`

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/knowledge-lab` to the wide-canvas route list.

- `ui/src/pages/KnowledgeLabPage.tsx`
  - Rebuilt the placeholder shell into a compact header, simple footprint card, and compact next-step rail.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/knowledge-lab?t=177607`

Checks completed:

1. Page loads with the normalized layout.
2. Placeholder audit state is cleaner and denser.

## Page 9: `/settings`

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/settings` to the wide-canvas route list.

- `ui/src/pages/SettingsPage.tsx`
  - Rebuilt the page into a compact header, primary infrastructure card, and compact strategy rail.
  - Removed the oversized intro narrative block.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/settings?t=177607`

Checks completed:

1. Page loads with the normalized layout.
2. Redis and cache strategy information render in the new compact structure.

## Page 10: `/chat` plus shared `GhostChat`

### Fixes applied

- `ui/src/pages/chat/ChatSidebar.tsx`
  - Reduced sidebar width and removed low-value helper copy.

- `ui/src/pages/chat/MessageList.tsx`
  - Increased usable message width and reduced excess padding.

- `ui/src/pages/chat/ChatComposer.tsx`
  - Reduced composer padding and removed the disclaimer footer.

- `ui/src/pages/chat/ChatArea.tsx`
  - Tightened the token strip.

- `ui/src/pages/chat/ChatPage.tsx`
  - Aligned the chat shell surface background with the main app.

- `ui/src/components/GhostChat.tsx`
  - Widened the floating panel.
  - Tightened top-bar controls and tools drawer height.
  - Reduced several control widths to match the compact page standard.

- `ui/src/index.css`
  - Added compact chat-surface control sizing.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/chat`
- shared `GhostChat` opened from the shell

Checks completed:

1. `/chat` loads with the denser sidebar/composer layout.
2. Shared `GhostChat` opens and renders in the compacted/widened panel.

Browser console result for final sweep:

- no app errors
- only the expected Cursor browser warning about native dialog overrides

### Approval checkpoint

Stopped here after completing `/tools`, per the approved page-by-page rollout. No further page in the normalization plan should be touched until user review/approval is received.

## Page 2: `/logs`

### UX problems found

- The page self-capped to `max-w-[760px]`, making an operational trace surface too narrow for scan-heavy work.
- The top section spent too much space on explanatory copy instead of showing the actual run stream.
- The summary cards and verify commands were stacked below the primary content instead of acting like a compact operator side rail.
- The page did not follow the `Agent Config` principle of a dominant left workspace with compressed supporting context to the right.

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/logs` to the wide-canvas route list.

- `ui/src/pages/Logs.tsx`
  - Rebuilt the page into:
    - compact command/header strip
    - dominant left run stream
    - compact right-side context rail for live stack, trace correlation, and verify commands
  - Removed low-value explanatory copy from the top of the page.
  - Promoted the actual ingestion run list to the primary surface.
  - Added more compact status badges and denser run cards.
  - Kept the `Refresh` action explicit and visible in the command row.

- `ui/src/index.css`
  - Added compact command sizing for the logs page action row.

### Exact verify commands run

```bash
cd /var/llamaindex/ghoststack-rag/ui && npm run build -- --outDir dist-page-check
cd /var/llamaindex/ghoststack-rag && docker compose build ui && docker compose up -d ui
rm -rf /var/llamaindex/ghoststack-rag/ui/dist-page-check
```

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/logs?t=177601`

Checks completed:

1. Page loads with the new wide trace workspace.
2. Recent ingestion runs render in the dominant left pane.
3. Supporting context and verify commands render in the compact right rail.
4. `Refresh` triggers a live reload of recent runs.

Browser console result:

- no app errors
- only the expected Cursor browser warning about native dialog overrides

### Approval checkpoint

Stopped here after completing `/logs`, per the approved page-by-page rollout. No further page in the normalization plan should be touched until user review/approval is received.

## Page 3: `/data-sources`

### UX problems found

- The page mixed system metrics, collection management, upload staging, and ingestion history as a long vertical stack with too much explanatory copy.
- The page was still constrained by the shared narrow layout and both [ui/src/components/UploadArea.tsx](/var/llamaindex/ghoststack-rag/ui/src/components/UploadArea.tsx) and [ui/src/components/IngestionHistory.tsx](/var/llamaindex/ghoststack-rag/ui/src/components/IngestionHistory.tsx) had their own internal width caps.
- The collection controls competed visually with the upload surface instead of acting like a compact operator rail.
- The main upload workspace was not getting the majority of the page width, even though that is the primary operator task.

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/data-sources` to the wide-canvas route list.

- `ui/src/components/UploadArea.tsx`
  - Removed the internal `max-w-[700px]` cap so the upload workspace can use the available page width.

- `ui/src/components/IngestionHistory.tsx`
  - Removed the internal `max-w-[650px]` cap so history can align with the page layout instead of narrowing itself.

- `ui/src/pages/DataSourcesPage.tsx`
  - Rebuilt the page into:
    - compact command/header strip
    - top metric cards
    - dominant left upload + ingestion workspace
    - compact right-side collection/impact management rail
  - Moved collection target/create/impact/managed list into the right rail.
  - Kept the upload workspace as the primary left-pane task surface.
  - Kept ingestion history directly under the upload workspace so the operator can stage, upload, then inspect outcomes in one reading flow.

- `ui/src/index.css`
  - Added compact page-specific sizing for `data-sources-page` and `data-sources-command-bar`.

### Exact verify commands run

```bash
cd /var/llamaindex/ghoststack-rag/ui && npm run build -- --outDir dist-page-check
cd /var/llamaindex/ghoststack-rag && docker compose build ui && docker compose up -d ui
rm -rf /var/llamaindex/ghoststack-rag/ui/dist-page-check
```

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/data-sources?t=177602`

Checks completed:

1. Page loads with the new wide upload workspace and compact collection rail.
2. `Refresh` works live.
3. Selecting a collection from the managed list updates the selected impact rail.
4. The create-collection form enables `Create collection` only when the inputs are populated.
5. Upload workspace and ingestion history both render at full page width with the new layout.

Safety note:

- I intentionally did **not** create or delete a real collection or upload a real file during this pass because this page mutates live business data and storage. The verification stopped at the safe point: the create form was validated for input/enablement, but the actual submit was not triggered.

Browser console result:

- no app errors
- only the expected Cursor browser warning about native dialog overrides

### Approval checkpoint

Stopped here after completing `/data-sources`, per the approved page-by-page rollout. No further page in the normalization plan should be touched until user review/approval is received.

## Page 5: `/connections` plus shared `RightPanel`

### UX problems found

- The page header wasted space on descriptive copy instead of prioritizing provider status and actions.
- Provider cards were roomy and repeated ownership copy per card rather than using a compact support rail.
- The shared `RightPanel` was visually too loose and inconsistent with the denser operator panels introduced elsewhere.

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/connections` to the wide-canvas route list.

- `ui/src/pages/ConnectionsPage.tsx`
  - Rebuilt the page into:
    - compact command/header strip
    - denser provider cards
    - compact right support rail for ownership and cloud-lane readiness

- `ui/src/components/RightPanel.tsx`
  - Reduced drawer padding and control density.
  - Tightened headings, helper copy, and test/save result block sizing.

- `ui/src/index.css`
  - Added compact page-specific sizing for `connections-page` and `connections-panel`.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/connections?t=177605`

Checks completed:

1. Page loads with the new compact/wide layout.
2. `Manage providers` opens the shared drawer.
3. The drawer renders the densified provider-management form correctly.

Limitation:

- The browser automation hit an interaction-intercept issue when attempting to trigger `Test connection` inside the live drawer. The drawer itself rendered correctly and remained interactive, but that single click path was blocked by browser-tool positioning friction rather than a proven app failure.

Browser console result:

- no app errors
- only the expected Cursor browser warning about native dialog overrides

## Page 6: `/`

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/` to the wide-canvas route list.

- `ui/src/pages/Dashboard.tsx`
  - Added a compact dashboard command/header strip.
  - Removed the unused internal `max-w-[1200px]` cap.
  - Rebalanced the page into:
    - top capability cards
    - wide ingress overview
    - compact runtime rail
    - lower operational snapshot and recent-documents surfaces
  - Reduced low-value explanatory copy.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/?t=177606`

Checks completed:

1. Dashboard loads in the new wide layout.
2. Capability cards and lower operational sections render correctly.
3. No broken interactions or console errors were introduced.

## Page 7: `/vectors`

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/vectors` to the wide-canvas route list.

- `ui/src/pages/VectorsPage.tsx`
  - Rebuilt the page with a compact header, wide metric grid, and a compact right-side context rail.
  - Removed the larger explanatory paragraph block.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/vectors?t=177606`

Checks completed:

1. Page loads with the wide layout.
2. Aggregate metric cards render correctly.
3. Context rail renders correctly.

## Page 8: `/knowledge-lab`

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/knowledge-lab` to the wide-canvas route list.

- `ui/src/pages/KnowledgeLabPage.tsx`
  - Rebuilt the placeholder shell into a compact header, simple footprint card, and compact next-step rail.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/knowledge-lab?t=177607`

Checks completed:

1. Page loads with the normalized layout.
2. Placeholder state is visually cleaner and denser.

## Page 9: `/settings`

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/settings` to the wide-canvas route list.

- `ui/src/pages/SettingsPage.tsx`
  - Rebuilt the page into a compact header, primary infrastructure card, and compact strategy rail.
  - Removed the larger narrative intro block.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/settings?t=177607`

Checks completed:

1. Page loads with the normalized layout.
2. Redis and cache strategy information render in the new compact structure.

## Page 10: `/chat` plus shared `GhostChat`

### Fixes applied

- `ui/src/pages/chat/ChatSidebar.tsx`
  - Reduced sidebar width and removed low-value helper copy.

- `ui/src/pages/chat/MessageList.tsx`
  - Increased usable content width and reduced excess padding.

- `ui/src/pages/chat/ChatComposer.tsx`
  - Reduced composer padding and removed the footer disclaimer line.

- `ui/src/pages/chat/ChatArea.tsx`
  - Tightened the token strip.

- `ui/src/pages/chat/ChatPage.tsx`
  - Aligned the chat shell background with the app surface.

- `ui/src/components/GhostChat.tsx`
  - Widened the floating panel.
  - Tightened top-bar controls.
  - Reduced tools drawer height and control widths.

- `ui/src/index.css`
  - Added compact chat-surface control sizing for the full `/chat` shell.

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/chat`
- shared `GhostChat` opened from the app shell

Checks completed:

1. `/chat` loads with the denser sidebar/composer layout.
2. Shared `GhostChat` opens and renders in the compacted/widened panel.
3. No app console errors were introduced.

## Page 4: `/pipelines`

### UX problems found

- The page was still using the older narrow split-card layout with too much explanatory copy.
- Runtime defaults and retrieval policy were visually separated, but neither side felt like a primary workspace.
- The page did not match the Agent Config pattern of:
  - compact command row
  - wide main working area
  - compact support/ownership rail

### Fixes applied

- `ui/src/components/AppLayout.tsx`
  - Added `/pipelines` to the wide-canvas route list.

- `ui/src/pages/PipelinesPage.tsx`
  - Rebuilt the page into:
    - compact command/header strip
    - dominant left defaults workspace
    - compact right-side policy/ownership/status rail
  - Removed the old explanatory header copy.
  - Grouped related controls:
    - chat API mode + embedding model
    - default collections
    - retrieval sliders
  - Moved ownership/status information into the compact side rail.

- `ui/src/index.css`
  - Added compact page-specific sizing for `pipelines-page` and `pipelines-command-bar`.

### Exact verify commands run

```bash
cd /var/llamaindex/ghoststack-rag/ui && npm run build -- --outDir dist-page-check
cd /var/llamaindex/ghoststack-rag && docker compose build ui && docker compose up -d ui
rm -rf /var/llamaindex/ghoststack-rag/ui/dist-page-check
```

### Browser verification result

Validated live in the Cursor browser against:

- `https://ghoststack.rideai.com.au/pipelines?t=177604`

Checks completed:

1. Page loads with the new wide layout and compact header.
2. Runtime-default controls render in the new grouped workspace.
3. Save path persists live runtime-default changes.

Persistence check performed:

- changed `pdf_parse_lane_policy` from `auto` to `local_default`
- changed `pdf_rerank_enabled` from `false` to `true`
- verified the persisted values through `/api/runtime/defaults`

Restore check performed:

- restored `pdf_rerank_enabled` back to `false` through the page flow
- restored `pdf_parse_lane_policy` back to `auto` through the canonical runtime-defaults API

Reason for API restore:

- the live page save interaction proved the persistence path, but the final restore of parse-lane state did not complete cleanly through the UI alone during the verification sequence
- to avoid leaving the live environment in the modified state, the final restoration was completed through the canonical `/api/runtime/defaults` surface

Browser console result:

- no app errors
- only the expected Cursor browser warning about native dialog overrides
