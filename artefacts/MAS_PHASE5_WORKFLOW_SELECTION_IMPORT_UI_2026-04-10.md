# MAS Phase 5: Workflow Selection + Import UI

Date: 2026-04-10

## Goal

Expose the new workflow-definition model directly in Ghost ChatUI so a human can:

- select which MAS workflow will run next
- load the current workflow definition as JSON or YAML
- paste/import a new definition from the UI
- run MAS against the selected imported workflow

This closes the gap between "definition-driven backend" and "actually programmable by the operator".

## What Changed

### Frontend

- Added workflow-definition API helpers in `Ghost-chatUI` for:
  - list definitions
  - import definitions
  - export a selected definition as JSON or YAML
- Reworked MAS state so the UI now tracks:
  - all available workflow definitions
  - the selected workflow id
  - the resolved head agent
  - per-workflow min/max child-agent limits
- Replaced the hardcoded `mas_consult_v1` execution path with the selected workflow id.
- Updated MAS limits so imported workflow definitions control the required and maximum child-agent count.
- Added a right-panel `WORKFLOW DEFINITION` control area with:
  - workflow selector
  - `Load YAML`
  - `Load JSON`
  - format selector
  - textarea import surface
  - `Import Workflow`
- Added UI support for workflow-defined fixed head agents so the active agent is no longer blindly forced as head agent when the definition says otherwise.

### Runtime Behavior

- New MAS runs now use whichever workflow is selected in the panel.
- Imported workflows become selectable immediately after import.
- The selected workflow remains the active one for subsequent MAS runs until changed.

## Design Notes

- The UI now honors the workflow contract instead of treating `JSON/YAML` as documentation only.
- The backend remains the canonical executor and validator.
- Import intentionally uses the existing backend import endpoint rather than inventing a second frontend-only format path.

## Verification

### Static Verification

```bash
cd /var/Ghost-chatUI
npm run lint
```

### Deployment

```bash
cd /var/llamaindex/ghoststack-rag
docker compose up -d --build ghost-chatui
```

### Live API Check

```bash
cd /var/llamaindex/ghoststack-rag
python3 - <<'PY'
import json, urllib.request
with urllib.request.urlopen('https://ghoststack.rideai.com.au/api/workflows/definitions') as r:
    data = json.load(r)
print('\n'.join(f"{item['workflow_id']} | {item['name']}" for item in data))
PY
```

Observed output after verification:

```text
mas_consult_v1 | Head-Agent MAS Consult
mas_ui_import_test_v1 | UI Imported MAS Workflow
```

## Human Test

Human-style browser verification passed on the live site.

### Test Flow

1. Open right panel.
2. Confirm workflow controls are visible.
3. Load current workflow YAML into the textarea.
4. Edit and import a new compatible workflow definition:
   - `workflow_id: mas_ui_import_test_v1`
   - `name: UI Imported MAS Workflow`
5. Verify the imported workflow becomes selected.
6. Run MAS using the imported workflow with prompt:

```text
Return only the token UI_WORKFLOW_IMPORT_OK and nothing else.
```

7. Verify the final visible assistant response is exactly:

```text
UI_WORKFLOW_IMPORT_OK
```

### Observed Labels

- `WORKFLOW DEFINITION`
- `Load YAML`
- `Load JSON`
- `Import Workflow`
- `UI Imported MAS Workflow`
- `Imported workflow UI Imported MAS Workflow. It is now selected for new MAS runs.`

## Acceptance Criteria

- A human can select a workflow definition from Ghost ChatUI.
- A human can load the selected definition into the UI as YAML or JSON.
- A human can import a new workflow definition from the UI.
- The imported workflow becomes selectable without restarting services.
- A live MAS run can execute successfully against the imported workflow.

## Next Sensible Step

- Add workflow delete/archive/version-history controls so imported test/example workflows do not accumulate forever.
- Add a dedicated GhostDASH workflow management screen if workflow editing is going to become a first-class operator task.
