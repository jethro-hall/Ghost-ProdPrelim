# Agent Config Panel Sizing Fix

## Problem

The `/agent` page had drifted into two conflicting sizing systems:

- the left authoring column still used large, roomy form controls
- the right settings panel used an ultra-compressed inspector scale
- the two-column layout only activated at the `xl` breakpoint, so common desktop widths collapsed into a long single column
- the right-side section chooser existed, but it was hidden behind small dot markers instead of obvious grouped navigation
- the embedded `GhostChat` panel used a narrower, shorter box with different spacing than the surrounding operator UI

This made the page feel mismatched, oversized in some places, cramped in others, and hard to scan.

## Canonical surfaces touched

- `ui/src/pages/AgentConfigPage.tsx`
- `ui/src/components/GhostChat.tsx`
- `ui/src/index.css`

## Fixes applied

### 1. Earlier desktop split for `/agent`

- Moved the two-column Agent Config layout from `xl` down to `lg`
- Kept the left authoring editor dominant, but ensured the right inspector remains visible on normal desktop widths
- Tuned the column ratio so the right rail is readable instead of feeling bolted on

### 2. Real grouped navigation inside the right inspector

- Replaced the hover-only dot rail with visible grouped section buttons:
  - `Connection`
  - `Generation`
  - `Voice & status`
  - `Runtime summary`
  - `Collections`
  - `Tools`
  - `Odoo`
- Made the group bar sticky inside the right rail
- Updated the scroll offsets so clicking a group lands the target section below the sticky nav rather than under it

### 3. Shared sizing rhythm across left and right panels

- Normalized input, select, and textarea density on the `/agent` page
- Reduced the visual mismatch between the larger left editor and smaller right inspector
- Slightly increased the inspector control size so it is compact without becoming cramped

### 4. GhostChat box and padding pass

- Increased the embedded `GhostChat` panel width and open height
- Tightened and normalized the header, toolbar, message area, and footer spacing
- Added internal scroll for the tools section so expanded chat controls do not blow out the whole panel
- Kept the chat visually aligned with the same glass/rounded language used on the page

### 5. Opportunistic cleanup while validating

- Fixed pre-existing chat UI type issues in:
  - `ui/src/pages/chat/ChatComposer.tsx`
  - `ui/src/pages/chat/ChatArea.tsx`
  - `ui/src/pages/chat/ChatPage.tsx`
  - `ui/src/pages/chat/ChatSidebar.tsx`
  - `ui/src/pages/chat/MessageList.tsx`
- Removed one unused prop
- Corrected multiple `strokeLinelinejoin` typos to `strokeLinejoin`

## Human-style verification

### Operator journey tested

1. Open `https://ghoststack.rideai.com.au/agent`
2. Confirm the page stays two-column at a normal desktop width (`1280x1024`)
3. Confirm the right settings panel shows a visible grouped section selector
4. Click `Tools` in the grouped selector and confirm the inspector scrolls internally
5. Open `GhostChat`
6. Confirm the chat panel renders wider/taller with tighter internal spacing and does not feel disconnected from the page

### Result

- Two-column layout at normal desktop width: passed
- Right inspector visible without horizontal drift: passed
- Right inspector internal scrollbar visible: passed
- Grouped section selector visible and clickable: passed
- Group click scroll behavior: passed
- Embedded `GhostChat` size/padding pass visible on the live page: passed

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag/ui && npm run lint
cd /var/llamaindex/ghoststack-rag/ui && npm run build -- --outDir dist-agent-sizing-check
cd /var/llamaindex/ghoststack-rag && docker compose build ui && docker compose up -d ui
cd /var/llamaindex/ghoststack-rag && git status -sb
```

## Acceptance criteria

- `/agent` uses a readable two-column layout on standard desktop widths, not only extra-wide screens
- the right settings panel keeps its own vertical scroll
- the settings group selector is visible and usable without hover-discovery
- left and right panel form controls feel like one UI system
- the embedded `GhostChat` panel uses improved width, height, and padding
- the live UI rebuilds successfully and serves the updated layout
