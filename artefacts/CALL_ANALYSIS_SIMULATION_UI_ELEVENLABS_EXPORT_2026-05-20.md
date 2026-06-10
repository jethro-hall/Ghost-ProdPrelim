# Call Analysis Simulation UI + ElevenLabs JSON Export (2026-05-20)

## Requirement summary

Add a dedicated GhostDASH page, reachable from the left navigation, that lets operators:

1. select a generated simulation JSON
2. view strict copy-ready JSON for ElevenLabs test editor
3. copy the payload directly

## Files changed

- `backend/src/ghostdash_api/integrations/elevenlabs_simulations.py`
- `backend/src/ghostdash_api/control_api.py`
- `backend/tests/test_elevenlabs_simulations_api.py`
- `ui/src/pages/ElevenLabsSimulationPacksPage.tsx`
- `ui/src/App.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/components/AppLayout.tsx`
- `ui/src/api.ts`

## Architecture impact

- Added new read-only API surface:
  - `GET /api/elevenlabs/analysis/simulations`
  - `GET /api/elevenlabs/analysis/simulations/{file_name}`
- API reads generated simulation files from:
  - `artefacts/call-simulations/`
- API returns:
  - simulation metadata list
  - selected simulation payload
  - strict ElevenLabs test JSON object + pretty JSON string
- UI route added:
  - `/analysis/simulation-packs`
- Sidebar now includes:
  - `Simulation Packs` under `Quality Assurance`

## Strict ElevenLabs JSON shape output

The API intentionally returns these keys to match ElevenLabs testing editor shape:

- `name`
- `type` (`llm`)
- `chat_history`
- `dynamic_variables`
- `from_conversation_metadata`
- `success_condition`
- `success_examples`
- `failure_examples`
- `tool_call_parameters`

## Tests run

```bash
python3.12 -m compileall backend/src
python3.12 -m pytest backend/tests/test_elevenlabs_simulations_api.py -q
python3.12 -m pytest backend/tests/test_elevenlabs_analysis_api.py -q
npm --prefix ui run lint
```

## Test output

- backend compile: passed
- simulation API tests: `2 passed`
- analysis API regression tests: `5 passed`
- UI lint/typecheck: passed

## Manual verification (human)

1. Open GhostDASH and navigate to `Simulation Packs` in left sidebar.
2. Select a simulation item in the left panel.
3. Confirm strict JSON appears in the right code panel.
4. Click `Copy JSON`.
5. Paste into ElevenLabs test JSON editor and confirm schema acceptance.

## Risks and notes

- Some generated filenames include unusual but valid characters; API enforces strict filename regex and blocks unsafe paths.
- Payload generation is read-only and does not alter simulation files.
