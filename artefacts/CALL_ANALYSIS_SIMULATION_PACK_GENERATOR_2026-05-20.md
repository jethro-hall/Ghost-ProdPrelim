# Call Analysis Simulation Pack Generator — 2026-05-20

## Requirement

Create repeatable, detailed real-world test/use-case outputs from call-analysis CSV export with transcript-style playback and evaluation of:

- tools
- LLM reasoning
- user experience
- HubTiger booking capability and timing

Per-call output name required:

- `JSON_{{USER}}&{{BRIEFSUMMARY}}_SIMULATION.json`

## Implemented

### New generator script

- `scripts/call_analysis/generate_call_simulations.py`

### New operator doc

- `docs/CALL_ANALYSIS_SIMULATION_GENERATOR.md`

## Behavior

For each CSV row:

1. Reads conversation metadata from CSV.
2. Fetches full transcript from:
   - `/api/elevenlabs/analysis/conversations/{id}/transcript`
3. Builds transcript playback lines with:
   - role
   - timestamp
   - ASR/LLM/TTS/workflow timing
   - tool dispatch + tool result traces
4. Calculates evaluation signals for:
   - tool execution quality
   - LLM reasoning behavior
   - UX quality
   - HubTiger booking capability and elapsed timing
5. Generates repeatable real-world test suite blocks per call.
6. Writes output JSON using required naming pattern.

Also writes:

- `SIMULATION_MANIFEST.json` with generated files and fetch errors.

## Notes

- Transcript endpoint fetch can require voice key depending environment.
- If transcript fetch is unavailable, script falls back to CSV summary transcript mode.
- CSV file from local Windows path is not present in this Linux workspace by default; run generator with a path accessible from this machine.

## Verification commands

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 -m py_compile scripts/call_analysis/generate_call_simulations.py
python3.12 scripts/call_analysis/generate_call_simulations.py --help
```

## Human QA (operator)

1. Place/export CSV on this host (or mount/share path).
2. Run generator command from docs.
3. Open 3 sample output JSONs and verify:
   - transcript render quality
   - tool traces
   - booking timing fields
   - repeatable test steps realism
4. Confirm filename format and manifest completeness.
