# GhostDASH UI Parity Artifact

## Intent
This artifact records the dashboard parity rebuild that maps the live GhostDASH frontend onto the reference prototype from `jethro-hall/GhostAI---Slim-Dashboard` while preserving the existing live `/api/*` contracts.

## Scope Completed
- Rebuilt the operator shell in `ui/src/components/AppLayout.tsx`, `Sidebar.tsx`, and `Header.tsx` to follow the prototype layout and spacing.
- Split the experience into the designer's page layer: Knowledge & Retrieval, Data Sources, Parsing Pipelines, LLM Connections, Vector DBs, Knowledge Lab, Agent Config, System Settings, and Operational Trace.
- Restyled the right-side provider panel, the sync popup, and the bottom GhostChat panel to visually match the prototype family.
- Added frontend multi-file staging and sequential upload submission without changing backend ingestion routing.
- Resolved two production-tested navigation issues discovered during human testing: duplicate `/logs` navigation and a non-functional GhostDASH home logo.

## Reference To Live Mapping
- Reference `Sidebar` -> `ui/src/components/Sidebar.tsx`
- Reference `Header` -> `ui/src/components/Header.tsx`
- Reference `GhostCard` -> `ui/src/components/GhostCard.tsx`
- Reference `UploadArea` -> `ui/src/components/UploadArea.tsx`
- Reference `IngestionHistory` -> `ui/src/components/IngestionHistory.tsx`
- Reference `SyncPopup` -> `ui/src/components/FullScreenLoader.tsx`
- Reference `ChatPanel` -> `ui/src/components/GhostChat.tsx`
- Reference `BackgroundOrbs` -> `ui/src/components/BackgroundOrbs.tsx`
- New route pages -> `ui/src/pages/*.tsx`

## Preserved Contracts
No backend styling changes were made for the parity slice.

The live frontend still uses:
- `GET /api/connections`
- `GET /api/capabilities`
- `GET /api/documents`
- `GET /api/runs`
- `POST /api/connections`
- `POST /api/upload`
- `POST /api/sync`
- `GET /api/tasks/{task_id}`
- `/agent/chat` and `/agent/chat/stream`

## Multi-File Upload Design
The prototype shows a multi-file upload flow. The live implementation now supports that without inventing a new batch backend endpoint.

Behavior:
- Files are staged in the frontend before upload.
- Each staged file keeps its own requested lane value at the moment it is added.
- Upload submission runs sequentially per file through the existing `POST /api/upload` path.
- This preserves backend per-file handling for mixed batches such as `pdf`, `txt`, and `xlsx`.
- Workbook-specific structure metadata still surfaces in ingestion history via the live document list.

Why this approach:
- It avoids backend drift.
- It respects existing structured vs unstructured routing.
- It keeps mixed-type upload behavior deterministic and easy to troubleshoot.

## Frontend Files Changed
- `ui/src/App.tsx`
- `ui/src/index.css`
- `ui/src/components/AppLayout.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/components/Header.tsx`
- `ui/src/components/RightPanel.tsx`
- `ui/src/components/GhostChat.tsx`
- `ui/src/components/FullScreenLoader.tsx`
- `ui/src/components/BackgroundOrbs.tsx`
- `ui/src/components/GhostCard.tsx`
- `ui/src/components/UploadArea.tsx`
- `ui/src/components/IngestionHistory.tsx`
- `ui/src/components/ReferenceIcons.tsx`
- `ui/src/pages/Dashboard.tsx`
- `ui/src/pages/DataSourcesPage.tsx`
- `ui/src/pages/ConnectionsPage.tsx`
- `ui/src/pages/PipelinesPage.tsx`
- `ui/src/pages/VectorsPage.tsx`
- `ui/src/pages/KnowledgeLabPage.tsx`
- `ui/src/pages/SettingsPage.tsx`
- `ui/src/pages/AgentConfigPage.tsx`
- `ui/src/pages/Logs.tsx`

## Human-Style Verification Performed
Deployment path:
- Rebuilt and restarted the live `ui` container with `docker compose up -d --build ui`.
- Verified the deployed Caddy-served app at `https://ghoststack.rideai.com.au/`.

Verified in browser:
- Sidebar navigation works across all designer pages.
- Page headers update correctly per route.
- Knowledge & Retrieval, Operational Trace, Data Sources, Parsing Pipelines, LLM Connections, Vector DBs, Knowledge Lab, Agent Config, and System Settings all render without obvious visual breakage.
- Sidebar collapse/expand works.
- GhostChat opens and closes correctly.
- GhostDASH logo now returns the user to `/`.
- `/logs` now has a single navigation entry and a single active state.

## Findings And Fixes During Testing
- Finding: both `Operational Trace` and `Audit Trail` linked to `/logs`, causing duplicate active states.
  Fix: collapsed to a single `/logs` nav entry.
- Finding: the GhostDASH logo button did not navigate home.
  Fix: converted it to a home link to `/`.
- Finding: the provider panel originally waited on `fetchConnections()` before opening, which made the control feel broken when the request failed.
  Fix: open the panel immediately and refresh connections in the background.

## Residual Risk
- `Parsing Pipelines`, `Knowledge Lab`, `Agent Config`, and `System Settings` are now production UI surfaces, but parts of those pages remain intentionally local/UI-first until the matching backend endpoints land.
- The next user-facing priority is still sync visibility so the full-sync popup matches the operator expectations described earlier.

## Verify Commands
- `cd /var/llamaindex/ghoststack-rag && git status -sb`
- `cd /var/llamaindex/ghoststack-rag/ui && npm exec vite build -- --outDir dist-check`
- `cd /var/llamaindex/ghoststack-rag && docker compose up -d --build ui`
- `docker logs --tail=120 ghoststack-rag-ui-1`

## Acceptance Criteria
- The live app exposes the designer page layer through the sidebar.
- Each page shows the correct route-specific header.
- The GhostDASH logo navigates home.
- `/logs` has only one visible nav entry and one active state.
