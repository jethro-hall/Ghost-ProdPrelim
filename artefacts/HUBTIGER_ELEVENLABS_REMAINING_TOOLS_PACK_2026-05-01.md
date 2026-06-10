# HubTiger ElevenLabs Remaining Tools Pack — 2026-05-01

## 1) Summary of requirement
- Provide the remaining HubTiger ElevenLabs tool scripts (beyond `jobsearch`, `jobretrieve`, `jobretrieve_fresh`) in importer-safe webhook schema format and prepare a downloadable pack.

## 2) Files created
- `scripts/hubtiger/hubtiger-api/elevenlabs-tools-download/hubtiger_booking_availability_readonly.json`
- `scripts/hubtiger/hubtiger-api/elevenlabs-tools-download/hubtiger_booking_create.json`
- `scripts/hubtiger/hubtiger-api/elevenlabs-tools-download/hubtiger_booking_update_slot.json`
- `scripts/hubtiger/hubtiger-api/elevenlabs-tools-download/hubtiger_booking_cancel.json`
- `scripts/hubtiger/hubtiger-api/elevenlabs-tools-download/hubtiger_quote_preview_price.json`
- `scripts/hubtiger/hubtiger-api/elevenlabs-tools-download/hubtiger_quote_add_line_item.json`
- Download bundle:
  - `artefacts/HUBTIGER_ELEVENLABS_REMAINING_TOOLS_PACK_2026-05-01.zip`

## 3) Architecture impact
- No backend runtime code changes.
- Tool JSON now aligns with current `/api/elevenlabs/hubtiger/tool` canonical function contract and ElevenLabs webhook schema shape.

## 4) Tests run
- JSON syntax validation for all 6 files with `python3 -m json.tool`.
- ZIP build for download package.

## 5) Test output
- All validations exited `0`.
- ZIP generated successfully with 6 tool files.

## 6) Manual verification steps
- Import each JSON in ElevenLabs Tools UI.
- Confirm no schema validation error.
- Run test call per tool with minimal payload.

## 7) Cleanup performed
- Kept output isolated under `elevenlabs-tools-download/` so existing files are not overwritten.

## 8) Known risks
- Legacy files in `scripts/hubtiger/hubtiger-api/elevenlabs-tools/` still include older operations that are no longer canonical in current HubTiger tool normalization.
- This pack intentionally includes only operations that map cleanly to the current supported function set (`booking_availability`, `booking_create`, `booking_update`, `quote_preview`, `quote_add_line_item`).
