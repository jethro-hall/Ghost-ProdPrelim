# Call Analysis Simulation Generator

This generator builds repeatable, detailed real-world simulation packs from exported call-analysis CSV data.

Output per call:

- `JSON_<USER>&<BRIEFSUMMARY>_SIMULATION.json`

Output location:

- `artefacts/call-simulations/`

---

## What it evaluates per call

1. **Tools**
   - dispatch count
   - success/failure count and success rate
   - top tools used
   - HubTiger dispatch timing

2. **LLM reasoning**
   - clarification behavior
   - turns before first tool
   - internal leakage detection signals

3. **User experience**
   - opening quality
   - response timing
   - concise/safe summary

4. **HubTiger booking capability**
   - booking intent detection
   - availability check usage
   - booking write path usage
   - pending-human-review evidence
   - elapsed seconds from booking intent to booking actions

5. **Repeatable real-world tests**
   - replay test
   - stale/no-cache retry test
   - booking end-to-end capability test
   - tool failure fallback test

---

## Transcript detail format

Each simulation includes:

- `full_transcript_playback`: structured turn-by-turn data
- `full_transcript_render`: human-readable lines similar to:
  - `agent`
  - `0s`
  - `Hey, Magic Mike...`
  - `TTS 535 ms`
  - `Tool dispatch: language_detection`
  - `Tool succeeded: language_detection`

---

## Required inputs

- CSV export from call analysis (example):
  - `call-analysis-export-2026-05-20T05-03-46-963Z.csv`
- Reachable transcript API at:
  - `https://ghoststack.rideai.com.au/api/elevenlabs/analysis/conversations/{conversation_id}/transcript`

If transcript fetch fails, generator falls back to CSV summary-only transcript mode.

---

## Usage

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 scripts/call_analysis/generate_call_simulations.py \
  --csv "/absolute/path/to/call-analysis-export-2026-05-20T05-03-46-963Z.csv" \
  --out-dir "artefacts/call-simulations" \
  --base-url "https://ghoststack.rideai.com.au" \
  --voice-key "$APP_VOICE_INGRESS_SECRET"
```

Optional:

- `--limit 20` to process first 20 rows
- `--no-fetch-transcript` to skip transcript endpoint calls

---

## Generated files

- One simulation JSON per conversation:
  - `JSON_Jeff_Hall&Booking_my_scooter_SIMULATION.json`
- Manifest:
  - `artefacts/call-simulations/SIMULATION_MANIFEST.json`

---

## Acceptance criteria

- Per-call simulation JSON exists with required naming pattern.
- Transcript playback includes timing/tool traces when endpoint is reachable.
- Evaluation section contains tools, LLM reasoning, UX, and booking capability.
- Repeatable test suite is present in each JSON.
