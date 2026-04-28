# Agent Config Redesign And Revert Artifact

## Problem

The Agent Configuration page was visually squeezed, the control flow was split across too many regions, and the settings side was not behaving like a proper inspector. The operator needed:

- a top command bar with live agent switching
- inline agent identity editing with dynamic save feedback
- a single main authoring column for prompt content
- a dedicated right-hand settings inspector with its own scroll behavior
- a database-backed revert action that discards unsaved local edits

## Canonical ownership

- Persistence owner: `agent_profiles` plus runtime-profile/tool-policy records in the existing backend database
- Canonical read API: `GET /api/agents` and `GET /api/tools/policy/{agent_id}`
- Canonical write API: `POST /api/agents` and `POST /api/tools/policy/{agent_id}`
- Canonical UI editor: `ui/src/pages/AgentConfigPage.tsx`

No duplicate settings surface was added. The redesign still uses the existing canonical APIs, and the new revert action only re-reads persisted state from those sources.

## Changes made

### 1. Full-width Agent Config canvas

- `ui/src/components/AppLayout.tsx`
- Added route-aware width handling using `useLocation()`
- `/agent` now uses the full available main-pane width (`max-w-none`) while other pages keep the existing `max-w-[960px]` layout

### 2. Command-bar layout and dynamic agent switching

- `ui/src/pages/AgentConfigPage.tsx`
- Removed the left-side saved-agent list
- Added a top control row with:
  - spinning activity wheel
  - live agent dropdown
  - `New`
  - `Revert`
  - `Save`
- Switching the dropdown updates the page state dynamically without navigation or browser refresh

### 3. Inline agent identity editor

- `ui/src/pages/AgentConfigPage.tsx`
- Added the top-left summary card requested in the mockup:
  - bold agent name
  - smaller grey model under it
  - edit icon
- Clicking the edit icon turns the summary into inline `Agent name` and `Model` fields
- Clicking away triggers dynamic save through the existing `/api/agents` endpoint
- The top spinner reflects in-flight activity

### 4. Dedicated right settings inspector

- `ui/src/pages/AgentConfigPage.tsx`
- Converted the right column into a dedicated settings rail
- Tightened spacing and grouping so the panel behaves more like a compact inspector
- The right rail now owns its own scroll area while the page layout remains fixed on desktop
- Added grouped jump markers on the far right for:
  - Connection
  - Generation
  - Voice & status
  - Runtime summary
  - Collections
  - Tools
  - Odoo
- Hovering a marker reveals the section label
- Clicking a marker scrolls the right rail to that section

### 5. Custom settings scrollbar

- `ui/src/index.css`
- Added `ghost-settings-scroll`
- Styled the right rail scrollbar with a dark track and light thumb so it reads like the reference style rather than the generic browser scrollbar

### 5b. Density pass

- `ui/src/pages/AgentConfigPage.tsx`
- `ui/src/index.css`
- Merged the identity card into the main prompt card so the centre stack loses one whole container gap
- Reduced padding around the agent name/model header
- Reduced the `First message` textarea height so the `System prompt` remains the dominant visible area
- Applied the same custom scrollbar styling to the centre prompt stack
- Aggressively reduced spacing and form-control padding inside the right-hand settings inspector
- Reduced inspector section padding and checkbox row padding so materially more settings fit on screen

### 6. Revert changes from database

- `ui/src/pages/AgentConfigPage.tsx`
- Added `Revert`
- The action re-fetches:
  - `fetchAgents()`
  - `fetchAgentToolPolicy(selectedId)`
- It then resets the page draft and Odoo/tool policy state to the persisted database values
- The button is disabled for unsaved/new agents because no canonical database row exists yet

## Human-style verification

### Operator journey tested

1. Open `/agent`
2. Confirm the top command bar renders with spinner, live dropdown, `New`, `Revert`, and `Save`
3. Switch the agent from the dropdown and confirm the form updates without leaving `/agent`
4. Click the right-rail `Odoo` marker and confirm the settings rail scrolls internally
5. Edit `First message`, then click `Revert`
6. Confirm the field returns to the last saved database value
7. Click the identity edit icon
8. Edit the model field, click away, and confirm the change persists after reload
9. Restore the original model value and confirm the canonical API shows `gpt-5.4`

### Evidence captured

- Screenshot: `docs/agent-config-wide-screen.png`
- Live page measurement after deploy:
  - viewport width: `1280`
  - rendered route container width: `1064`
  - right-rail marker set present: `true`
  - dynamic top dropdown present: `true`

### Browser verification result

- Dynamic dropdown switch without route change: passed
- Right-rail marker jump scroll: passed (`scrollTop` reached `1329`)
- Revert flow: passed
- Inline model autosave on blur: passed
- Restore original persisted model via canonical API: passed (`gpt-5.4`)
- Browser console/page errors during run: none
- Density pass browser-visible errors: none

## Build verification

- UI build succeeded with alternate output directory to avoid the existing `dist/` permission issue
- Live `ui` Docker service rebuilt and restarted successfully

## Exact verify commands

### Build check

```bash
cd /var/llamaindex/ghoststack-rag/ui && npm run build -- --outDir dist-agent-check
```

### Deploy updated UI

```bash
cd /var/llamaindex/ghoststack-rag && docker compose build ui && docker compose up -d ui
```

### Manual runtime spot-checks

```bash
curl -I http://localhost/agent
curl http://localhost/ | sed -n '1,12p'
```

### Browser-driven redesign verification

```bash
"$HOME/.local/node_modules/.bin/agent-browser" open http://127.0.0.1/agent --session agent-config-qa2
"$HOME/.local/node_modules/.bin/agent-browser" wait 1200 --session agent-config-qa2
"$HOME/.local/node_modules/.bin/agent-browser" snapshot -i --session agent-config-qa2
"$HOME/.local/node_modules/.bin/agent-browser" screenshot /var/llamaindex/ghoststack-rag/docs/agent-config-wide-screen.png --session agent-config-qa2
"$HOME/.local/node_modules/.bin/agent-browser" batch --bail --session agent-config-qa2 \
  "select @e19 RE- Business Strategist" \
  "wait 1500"
"$HOME/.local/node_modules/.bin/agent-browser" eval 'JSON.stringify({path: location.pathname, title: document.body.innerText.includes("RE- Business Strategist")})' --session agent-config-qa2
"$HOME/.local/node_modules/.bin/agent-browser" batch --bail --session agent-config-qa2 \
  "click @e33" \
  "wait 1000"
"$HOME/.local/node_modules/.bin/agent-browser" eval 'JSON.stringify({scrollTop: document.querySelector(".ghost-settings-scroll") ? document.querySelector(".ghost-settings-scroll").scrollTop : 0})' --session agent-config-qa2
"$HOME/.local/node_modules/.bin/agent-browser" batch --bail --session agent-config-qa2 \
  "select @e19 GhostDASH Assistant" \
  "wait 1200" \
  "snapshot -i"
"$HOME/.local/node_modules/.bin/agent-browser" batch --bail --session agent-config-qa2 \
  "fill @e24 TEMP UNSAVED LOCAL EDIT" \
  "click @e21" \
  "wait 1500"
"$HOME/.local/node_modules/.bin/agent-browser" eval 'document.querySelector("textarea") ? document.querySelector("textarea").value : ""' --session agent-config-qa2
"$HOME/.local/node_modules/.bin/agent-browser" batch --bail --session agent-config-qa2 \
  "click @e23" \
  "wait 600" \
  "snapshot -i" \
  "fill @e25 gpt-5.4-qa-check" \
  "click @e26" \
  "wait 1800" \
  "reload" \
  "wait 1200"
"$HOME/.local/node_modules/.bin/agent-browser" eval 'JSON.stringify({hasTempModel: document.body.innerText.includes("gpt-5.4-qa-check")})' --session agent-config-qa2
"$HOME/.local/node_modules/.bin/agent-browser" batch --bail --session agent-config-qa2 \
  "click \"button[title=\\\"Edit agent name and model\\\"]\"" \
  "wait 600" \
  "snapshot -i" \
  "fill @e25 gpt-5.4" \
  "click @e26" \
  "wait 1800" \
  "reload" \
  "wait 1200"
"$HOME/.local/node_modules/.bin/agent-browser" errors --session agent-config-qa2
"$HOME/.local/node_modules/.bin/agent-browser" close --all
python3.12 - <<'PY'
import json, urllib.request
with urllib.request.urlopen('http://127.0.0.1/api/agents') as r:
    data = json.load(r)
for agent in data:
    if agent.get('name') == 'GhostDASH Assistant':
        print(agent['runtime_profile']['llm_config']['model_id'])
        break
PY
```
### Canonical API restore verification

```bash
python3.12 - <<'PY'
import json, urllib.request
with urllib.request.urlopen('http://127.0.0.1/api/agents') as r:
    data = json.load(r)
for agent in data:
    if agent.get('name') == 'GhostDASH Assistant':
        print(agent['runtime_profile']['llm_config']['model_id'])
        break
PY
```

## Acceptance criteria

- The `/agent` page uses a visibly wider canvas than the shared default app pages
- The top command bar exposes spinner, dynamic agent dropdown, `New`, `Revert`, and `Save`
- Switching agents from the dropdown updates the editor without route navigation or page refresh
- The left side is focused on prompt authoring and identity editing
- The far-right settings inspector owns its own scroll behavior
- Hoverable jump markers allow quick movement between settings groups
- `Revert` reloads persisted agent/tool-policy state from the database, not local draft memory
- Inline model edits save on blur and persist through reload
- The original `GhostDASH Assistant` model is restored to `gpt-5.4`
- No browser-visible errors were produced during the tested flow
