# HubTiger Job Retrieve Webhook Schema Alignment — 2026-05-01

## Requirement

Align the HubTiger single-job retrieval webhook template to the new `hubtiger_job_retrieve` schema:

- canonical function `job_retrieve`
- endpoint `https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`
- exact operator guardrails for selection-required and no-cache usage
- payload fields `job_card_no` and optional `job_id`

## Root Cause

Repo templates still used legacy `hubtiger_job_get` tool shape and old endpoint, which can cause schema drift and incorrect tool wiring in ElevenLabs.

## Correct Layer

Tool template/config layer under `scripts/hubtiger/*`.

## Existing Component Reused

Reused existing webhook template files:

- `scripts/hubtiger/hubtiger_job_get.json`
- `scripts/hubtiger/hubtiger-api/elevenlabs-tools/hubtiger_job_get.json`

## Files Changed

- `scripts/hubtiger/hubtiger_job_get.json`
- `scripts/hubtiger/hubtiger-api/elevenlabs-tools/hubtiger_job_get.json`

## Proposed Change

Full-file replacement of both webhook templates to match the provided `hubtiger_job_retrieve` schema exactly:

- `name: hubtiger_job_retrieve`
- `function.constant_value: job_retrieve`
- `api_schema.url: https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool`
- added `store`, `cache_mode`, and selected identifier `payload` object
- added `content_type` and `response_mocks`
- included `X-Ghost-Voice-Key` header in template

## Why This Is Not a Static One-Off Patch

Both canonical script locations now share the same schema, preventing copy/paste divergence between tool setup paths.

## Token/Resource Impact

No runtime service changes; configuration/template only.

## Cleanup Performed

Removed legacy `job_get` contract usage from both active webhook template files.

## Tests / Proof

### Automated checks

- `python3 -m json.tool scripts/hubtiger/hubtiger_job_get.json`
- `python3 -m json.tool scripts/hubtiger/hubtiger-api/elevenlabs-tools/hubtiger_job_get.json`
- `rg "hubtiger_job_retrieve|job_retrieve|ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool" scripts/hubtiger/hubtiger_job_get.json scripts/hubtiger/hubtiger-api/elevenlabs-tools/hubtiger_job_get.json`

All passed.

## Acceptance Criteria

1. Both webhook templates resolve to `name = hubtiger_job_retrieve`.
2. Both templates call `/api/elevenlabs/hubtiger/tool`.
3. Both templates send constant function `job_retrieve`.
4. Both templates include `store`, `cache_mode`, and payload fields `job_card_no` and `job_id`.

## Exact Verify Commands

```bash
python3 -m json.tool scripts/hubtiger/hubtiger_job_get.json >/dev/null
python3 -m json.tool scripts/hubtiger/hubtiger-api/elevenlabs-tools/hubtiger_job_get.json >/dev/null
rg "hubtiger_job_retrieve|job_retrieve|ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool" \
  scripts/hubtiger/hubtiger_job_get.json \
  scripts/hubtiger/hubtiger-api/elevenlabs-tools/hubtiger_job_get.json
```
