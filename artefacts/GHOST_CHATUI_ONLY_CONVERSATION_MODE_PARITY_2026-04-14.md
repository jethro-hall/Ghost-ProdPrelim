# Ghost ChatUI Only Conversation Mode Parity

## Scope Decision

This delivery treats `https://ghoststack.rideai.com.au/ghost_chatui` as the only supported chat UI.

Out of scope for this pass:

- legacy GhostDASH `/chat`
- embedded legacy chat surfaces
- `_OLD` renames
- Docker/service removals
- route cleanup outside `ghost_chatui`

Those cleanup tasks are intentionally deferred to the next tidy-up project.

## Objective

Bring the previously shipped GhostDASH chat analysis behavior into `ghost_chatui` so this surface can explicitly run:

- `quick`
- `board`
- `working_session`

And ensure the selected mode flows through:

- chat bootstrap/runtime defaults
- live `/agent/chat/stream`
- persisted conversations/messages
- MAS workflow run creation/execution

## What Changed

### Ghost ChatUI

- Added first-class `ConversationMode` typing and payload support in:
  - `src/lib/types/chat.ts`
  - `src/lib/providers/api.ts`
  - `src/lib/providers/mock.ts`
- Added a real conversation-mode state to `src/lib/state/useGhostChat.ts`
- Restored selected mode from persisted conversation/message history
- Added explicit `Analysis Mode` controls in `src/components/layout/RightPanel.tsx`
- Threaded the selected mode through standard chat sends and MAS sends
- Updated focused UI/hook tests for the new contract

### GhostDASH backend

- Extended `WorkflowRunCreatePayload` with `conversation_mode`
- Stored `conversation_mode` in workflow run request metadata via `control_api`
- Forwarded `conversation_mode` from workflow execution into downstream `/agent/chat` consult calls
- Updated workflow executor tests to prove MAS carries the selected mode

## Files Changed

### Ghost ChatUI

- `/var/Ghost-chatUI/src/lib/types/chat.ts`
- `/var/Ghost-chatUI/src/lib/providers/api.ts`
- `/var/Ghost-chatUI/src/lib/providers/mock.ts`
- `/var/Ghost-chatUI/src/lib/utils/chatSeeds.ts`
- `/var/Ghost-chatUI/src/lib/state/useGhostChat.ts`
- `/var/Ghost-chatUI/src/components/layout/RightPanel.tsx`
- `/var/Ghost-chatUI/src/App.tsx`
- `/var/Ghost-chatUI/src/lib/state/__tests__/useGhostChat-tools-summary.test.ts`
- `/var/Ghost-chatUI/src/components/layout/__tests__/right-panel-tool-readiness.test.tsx`

### GhostDASH backend

- `backend/src/ghostdash_api/schemas.py`
- `backend/src/ghostdash_api/control_api.py`
- `backend/src/ghostdash_api/workflow_run_executor.py`
- `backend/tests/test_workflow_run_executor.py`

## Human-Style QA Findings

Primary route tested:

- `https://ghoststack.rideai.com.au/ghost_chatui/`

### Important environment note

Headed browser execution was requested first, but this host has no X display, so a visible browser could not be launched.

Observed host limitation:

- Chrome exited early with `Missing X server or $DISPLAY`

Fallback used:

- headless `agent-browser`
- real route
- real user-style navigation, thread selection, prompt entry, send, wait, and response inspection

### Single-agent mode checks

- `ghost_chatui` renders the `Analysis` section with:
  - `Quick`
  - `Board`
  - `Working Session`
- Quick finance prompt returned a concise scorecard-style answer
- Board finance prompt returned a more executive one-pass answer with broader breakdown
- Working Session finance prompt returned a deeper analysis and the browser snapshot did not show the old staged `Say CONTINUE` pattern

### MAS checks

- MAS mode was enabled from the `ghost_chatui` right panel
- A strict MAS prompt was submitted from the same UI
- Latest workflow run completed successfully with:
  - `status: completed`
  - `progress: 1.0`
  - `completed_agents: 4`
  - `failed_agents: 0`
  - `request.conversation_mode: working_session`

This verifies the selected analysis mode is now reaching MAS workflow execution, not only normal chat streaming.

### Browser automation note

In this headless environment, `agent-browser click` did not reliably activate the right-panel `Analysis Mode` and MAS toggle controls, even though normal chat interactions worked.

Workaround used during QA:

- DOM-level activation through `agent-browser eval` for those right-panel buttons

Interpretation:

- This was an automation-level quirk in this environment, not evidence of a backend failure
- The live app state changed correctly once the control activation was forced, and the resulting workflow run metadata proved the correct mode propagated end to end

## Screenshots

- `/var/llamaindex/ghoststack-rag/artefacts/ghost_chatui_working_session_mas_2026-04-14.png`

## Acceptance Criteria

- `ghost_chatui` is the only in-scope chat UI for this delivery
- `ghost_chatui` exposes `Quick`, `Board`, and `Working Session`
- live standard chat requests send and persist `conversation_mode`
- MAS workflow runs created from `ghost_chatui` persist the selected `conversation_mode`
- legacy chat cleanup is explicitly deferred to a later project

## Exact Verify Commands

```bash
cd /var/Ghost-chatUI && git status -sb
```

```bash
cd /var/llamaindex/ghoststack-rag && git status -sb
```

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

```bash
docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-agent-ingress-1
```

```bash
cd /var/Ghost-chatUI && npx pnpm lint
```

```bash
cd /var/Ghost-chatUI && npx pnpm vitest run src/lib/state/__tests__/useGhostChat-tools-summary.test.ts src/components/layout/__tests__/right-panel-tool-readiness.test.tsx
```

```bash
cd /var/llamaindex/ghoststack-rag && python3.12 -m pytest -q backend/tests/test_workflow_run_executor.py backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_runtime_profiles.py backend/tests/test_tools_api.py backend/tests/test_workflows_odoo_planning.py
```

```bash
curl -fsS https://ghoststack.rideai.com.au/api/workflows/runs?surface=ghost_chatui | jq '.[0] | {id,status,prompt,head_agent_name,current_step,progress,result_json}'
```

## Next Project

Do the cleanup separately:

- mark legacy chat surfaces `_OLD`
- decide whether the legacy GhostDASH `ui` service stays up
- de-duplicate chat implementations or remove the obsolete ones entirely
