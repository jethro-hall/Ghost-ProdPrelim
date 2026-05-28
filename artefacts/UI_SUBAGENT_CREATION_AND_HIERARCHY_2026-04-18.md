## UI sub-agent creation and hierarchy (2026-04-18)

### Objective
- Add sub-agent creation directly in Agent Configuration UI.
- Display lead/sub-agent hierarchy in the agent selector so parent-child relationships are obvious.

### Implemented changes
- File: `ui/src/api.ts`
  - Extended `AgentProfile` and `AgentProfilePayload` to include:
    - `agent_role?: "lead" | "sub"`
    - `parent_agent_id?: string | null`
    - `position?: number`

- File: `ui/src/pages/AgentConfigPage.tsx`
  - Added hierarchy derivation from agent list:
    - Lead agents rendered first.
    - Sub-agents rendered under lead with deterministic `position` ordering.
  - Replaced flat top dropdown as primary selector with a dedicated hierarchy panel:
    - `Lead Agents` panel in left column.
    - lead cards with nested sub-agent rows.
    - explicit `Lead`/`Sub` labels and active-state highlighting.
    - per-lead `+Sub` quick action.
    - top-level `New agent draft` row.
  - Added `Add Sub-Agent` button in command bar.
    - Enabled when a lead context is available (selected lead or selected sub-agent's parent lead).
    - Creates a new draft pre-populated as:
      - `agent_role = "sub"`
      - `parent_agent_id = <lead id>`
      - `position = sibling_count`
      - suggested name prefixed as `[SA] New Sub-Agent` (backend still enforces prefix normalization).
  - Added sub-agent validation in UI save guard:
    - block save if `agent_role = "sub"` and no `parent_agent_id`.
  - Added parent lead selector in identity edit mode for sub-agents.
  - Added role/parent badge in identity display mode.
  - Save normalization now persists `agent_role`, `parent_agent_id`, and `position` in payload.

### Why this approach
- Keeps backend as source of truth for role constraints and `[SA]` normalization.
- Improves operator clarity without introducing a second agent management screen.
- Avoids drift by preserving single save path (`POST /api/agents`) for lead and sub-agent records.

### Human test checklist
1. Open Agent Configuration.
2. Select a lead agent.
3. Click `Add Sub-Agent`.
4. Confirm draft opens with sub-agent role and parent lead preselected.
5. Save.
6. Confirm new sub-agent appears indented under the selected lead in dropdown.
7. Edit sub-agent identity and change parent lead, save again.
8. Confirm sub-agent moves under new lead grouping.
9. Confirm hierarchy panel shows grouped lead cards with nested sub-agent rows.

### Acceptance criteria
- `Add Sub-Agent` button exists and creates sub-agent draft without API/manual curl.
- Agent selector shows lead/sub hierarchy with indented sub-agent labels.
- Sub-agent save payload includes parent relationship fields.
- UI prevents creating a sub-agent without parent assignment.
