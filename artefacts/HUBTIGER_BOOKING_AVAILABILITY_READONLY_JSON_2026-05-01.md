# HubTiger Booking Availability Readonly JSON Alignment — 2026-05-01

## 1) Summary of requirement
- Generate ElevenLabs-importable HubTiger tool JSON using the exact webhook schema format provided by the user.

## 2) Files changed
- `scripts/hubtiger/hubtiger-api/elevenlabs-tools/hubtiger_booking_availability.json`
- `scripts/hubtiger/hubtiger_booking_availability.json`

## 3) Architecture impact
- No runtime code path changes.
- Tool-definition payload now uses the canonical GhostDASH endpoint:
  - `POST https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`
- Schema now includes required ElevenLabs-compatible keys:
  - `pre_tool_speech`
  - `content_type`
  - `response_mocks`
  - `X-Ghost-Voice-Key` header

## 4) Tests run
- JSON syntax validation for both tool files.

## 5) Test output
- Command:
  - `python3 -m json.tool scripts/hubtiger/hubtiger-api/elevenlabs-tools/hubtiger_booking_availability.json >/dev/null`
  - `python3 -m json.tool scripts/hubtiger/hubtiger_booking_availability.json >/dev/null`
- Result:
  - Both commands exited `0` (valid JSON).

## 6) Manual verification steps
- Import either file into ElevenLabs tool importer.
- Confirm no schema rejection.
- Confirm tool name appears as:
  - `hubtiger_booking_availability_readonly`
- Confirm request schema includes:
  - constant `function = booking_availability`
  - `store`, `start_date`, optional `end_date`, `cache_mode`, and nested optional `payload`.

## 7) Cleanup performed
- Replaced old booking availability webhook definitions that used the legacy endpoint format in both script locations.

## 8) Known risks
- This change aligns only the booking availability script to the supplied canonical format.
- Remaining HubTiger tool JSON files may still use older schema variants and should be normalized in the same pass if you want a full import pack with identical structure.
