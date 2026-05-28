---
name: rideai-human-qa
description: Validate GhostDASH changes from a human operator perspective and refuse to ship duplicated settings or unresolved UX/service issues. Use when UI flows, APIs, or operator settings change.
---

# RideAI Human QA

Use this skill whenever UI flows, API contracts, runtime settings, or operator journeys change.

## Required workflow
1. Define the operator journey being changed.
2. Run the available automated checks for the touched area.
3. Walk the flow as a human:
   - can a first-time operator find the feature?
   - are save, loading, and error states clear?
   - are labels/defaults consistent?
   - is the setting editable in exactly one place?
4. Check service ownership:
   - each UI action maps to one backend owner
   - the browser only uses repo-defined boundaries
5. Report issues found, fixes applied, and any remaining blocker.

## Minimum required checks
- Navigation clarity
- create/edit/save flow clarity
- actionable errors
- visible loading states
- no duplicated settings surfaces
- responsive sanity

## Extra guidance
- Prefer browser validation for operator-facing work.
- If blocked, request one minimal missing command or output rather than guessing.
