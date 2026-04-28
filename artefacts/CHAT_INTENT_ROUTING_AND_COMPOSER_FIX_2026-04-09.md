## Summary

This fix addresses two coupled chat defects observed in the live Ghost ChatUI flow:

1. Follow-up analysis prompts were being misclassified as document inventory requests.
2. The `/chat` composer retained the last sent prompt, increasing accidental resend risk.

## Root Cause

### Backend query-plan contamination

`agent_ingress.py` was sending a synthetic prompt to the workflow runtime that prepended:

- recent conversation memory
- current user request

The workflow planner then ran inventory heuristics against that combined text. If earlier turns mentioned phrases such as `document inventory`, a later unrelated finance request could trigger the inventory listing shortcut and return:

- `Indexed files in active corpora ...`

instead of a grounded analysis answer.

### Frontend resend friction

`ChatArea.tsx` passed the raw composer value directly into `sendMessage()` and did not clear the textarea after submit. Because the last prompt remained visible, accidental duplicate sends were easy during fast operator use.

## Changes

### Backend

- Added `current_message` to the internal query-plan request payload.
- Updated workflow runtime to forward `current_message` into `build_query_plan()`.
- Updated `build_query_plan()` to use the current user turn for:
  - query-mode classification
  - document inventory detection
  - structured candidate matching
  - semantic embedding lookup
  - target-document selection
  - final prompt user-question text
- Added an explicit runtime grounding rule so file answers must distinguish:
  - filename visibility
  - excerpt retrieval
  - verified full-content extraction

### Frontend

- Added a synchronous `sendLockRef` guard in `useChatEngine.ts`.
- Made `sendMessage()` return a boolean send result.
- Cleared the composer immediately on submit in `ChatArea.tsx`.
- Restored the drafted text only if the send was rejected before start.

## Regression Coverage

Added a targeted unit regression test ensuring a history-prefixed `document inventory` phrase does not hijack a later analysis request when `current_message` is supplied.

## Verification

### Automated

Executed in an isolated Python container:

```bash
docker run --rm -v /var/llamaindex/ghoststack-rag/backend:/app -w /app python:3.12-slim-bookworm bash -lc "pip install -q --upgrade pip setuptools wheel && pip install -q -e . pytest && pytest tests/test_ingestion_qdrant_batching.py -k 'document_inventory_questions_use_manifest or ignores_history_prefixed_inventory_phrases'"
```

Result:

- `2 passed, 8 deselected`

### UI build

```bash
cd /var/llamaindex/ghoststack-rag/ui && npm exec vite build -- --outDir dist-check
```

Result:

- production build completed successfully

### Human-style browser validation

Live route tested:

- `https://ghoststack.rideai.com.au/chat`

Validated:

- composer clears after send
- file-visibility answer now distinguishes visibility/excerpt confidence
- Greenwheels finance follow-up returns a business analysis answer
- the old inventory-dump regression did not reproduce

### Database confirmation

Recent stored messages confirmed:

- one user finance prompt
- one assistant finance analysis answer

with no duplicate follow-up prompt inserted by the patched flow during the verification run.

## Remaining Risks

- Citation presentation still looks noisy in the visibility answer and may need a later deduplication pass.
- Existing historical conversations still contain older polluted turns; this fix prevents new planning mistakes but does not rewrite old records.
