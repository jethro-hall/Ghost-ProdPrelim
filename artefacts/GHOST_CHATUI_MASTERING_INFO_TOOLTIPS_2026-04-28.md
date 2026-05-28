# Ghost ChatUI Mastering Info Tooltips (2026-04-28)

## Scope
- Added compact `i` info affordances next to every admin mastering option in `ghost_chatui`.
- Tooltip behavior: open on hover/focus, dark compact card, close via explicit `x` only, no extra action buttons.
- Content contract for each tooltip: concise explanation of **what the option is**, **why it exists**, and **expected voice impact**.

## Implementation Notes
- File changed: `/var/Ghost-chatUI/src/App.tsx`.
- Added tooltip state machine:
  - `openMasteringHelp` tracks a single open help topic.
  - `masteringHints` central map contains per-option titles and impact-oriented descriptions.
  - `renderMasteringInfo(helpKey)` renders icon + popover + close `x`.
- Wired info badges into controls:
  - Core voice: stability, similarity boost, style, use speaker boost.
  - Delivery/determinism: speed, model ID, language, seed, previous text, next text.
  - Pre-processing: text normalization, pronunciation dictionary locators, custom replacements.
  - Save controls: save preset, quick revert, auto-save.

## Clipping fix (overflow / scroll)
- **Issue:** Tooltips were `position: absolute` inside the scrollable mastering panel, so they were clipped by `overflow-y: auto` and the vertical scrollbar.
- **Fix:** Render the popover with `createPortal(..., document.body)` and `position: fixed` using `getBoundingClientRect()` for `top`/`left`. Clamp `maxWidth` to the viewport and flip to the **left** of the `i` when there is not enough room on the right.
- **Follow-up:** `onScroll` on the panel’s inner scroll container plus `window` `scroll` (capture) and `resize` recompute position so the bubble stays aligned while scrolling.
- **Cleanup:** When the panel closes, tooltip state is cleared so no orphan portal remains.

## Build/Runtime Validation
- Rebuilt/restarted `ghost-chatui` container:
  - `docker compose up -d --build ghost-chatui`
- Confirmed new frontend bundle in running container:
  - `index-Bopbuzlo.js`
  - `index-6TKWdKCZ.css`

## Human E2E Validation Checklist
- Open `https://ghoststack.rideai.com.au/ghost_chatui/`.
- Open Admin Mastering panel from composer.
- Verify each control label has a visible `i` icon.
- Hover each `i` and confirm:
  - Small dark tooltip appears.
  - One close control `x` appears.
  - No extra buttons exist.
  - Text explains what/why/expected impact.
- Click `x`; confirm tooltip closes immediately.
- Toggle fields while tooltips are used; confirm no control regressions.
- With the “Save preset” `i` near the right edge, confirm the full tooltip is visible (not cut off by the panel edge or scrollbar).
- Scroll the mastering panel while a tooltip is open; confirm the bubble tracks the `i` icon.
