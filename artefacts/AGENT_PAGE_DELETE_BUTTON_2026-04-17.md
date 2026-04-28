# Agent Page Delete Button (2026-04-17)

## Objective

Add a delete button on the Agent configuration page and connect it to safe backend deletion flow.

## UI Changes

- File: `ui/src/pages/AgentConfigPage.tsx`
  - Added a `Delete` button in the top command bar next to `Revert` and `Save`.
  - Added guarded delete flow:
    1. Fetch `POST /api/agents/{agent_id}/deletion-preview` (`scope=agent`)
    2. If blocked, surface readable blocker reasons in page status/error area
    3. If allowed, show human confirmation dialog with impact counts
    4. Execute `DELETE /api/agents/{agent_id}?confirm=true` with `confirmation_token`
    5. Refresh agent list and select the next available agent (or start new draft)
  - Added in-flight deletion state to disable destructive/competing actions while request is running.

## API Client Changes

- File: `ui/src/api.ts`
  - Added `AgentDeletionPreview` and `AgentDeleteResponse` types.
  - Added:
    - `fetchAgentDeletionPreview(agentId, scope)`
    - `deleteAgent(agentId, confirmationToken)`

## Safety and UX Notes

- Default-agent protection and active-workflow blockers are handled by backend preview and surfaced to user.
- Delete is disabled for unsaved/new draft state.
- Existing save/revert validation behavior remains unchanged.

## Verification

- Lints: no diagnostics on edited files.
- Build:
  - `npm run build` failed due existing `dist/assets` permissions (environment issue)
  - `npm run build -- --outDir dist-verify-agent-delete-button` succeeded