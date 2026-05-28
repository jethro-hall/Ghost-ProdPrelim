# Provider Delete Visibility Hotfix (2026-04-17)

## Problem
- Users could not reliably discover the delete action while editing providers in the right-side "Manage providers" panel.
- The existing destructive action only appeared lower in the form, which was easy to miss.

## Change
- Added an additional `Delete` button adjacent to the provider selector controls near the top of the panel in `ui/src/components/RightPanel.tsx`.
- This top-level delete button:
  - only renders for existing providers (`!isNewConnection`),
  - reuses the same guarded delete flow (`handleDelete`) backed by deletion preview and confirmation modal,
  - respects in-flight states (`testing`, `saving`, `deleting`).

## Safety/Behavior Notes
- No delete logic changed; only entry-point visibility improved.
- Existing backend safeguards remain in effect:
  - deletion preview,
  - blocker reasons,
  - confirmation token validation,
  - blocked deletions remain non-executable.

## Deployment
- Rebuilt and restarted `ui` and `caddy` services via Docker Compose to ensure live availability.

## Verification Focus
- Open "Manage providers".
- Select an existing provider.
- Confirm a visible `Delete` button near top controls.
- Click `Delete` and confirm deletion preview modal still appears with blockers/blast radius.
