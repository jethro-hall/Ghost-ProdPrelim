# Ghost ChatUI Finance Agent Human QA + Cache Transparency

Date: 2026-04-21
Environment: https://ghoststack.rideai.com.au/ghost_chatui/
Requested agent: Finance Agent (`0488d744-c66c-4d0e-9a29-c68fa81ba84f`)
Requested mode: board reporting

## Objective

Validate this prompt end-to-end and inspect what the model path actually received:

`Using Odoo, Show me GP/ROAS/performance and any relevant financial / assessment data for the previous 7 days from the 20/04/2026 for the BUSINESS Ride Electric Burleigh ONLY.`

Also validate cache behavior transparency.

## Mandatory diagnostics captured first

- `git status -sb` from `/var/llamaindex/ghoststack-rag`
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
- `docker logs --tail=120 ghost-edge-gateway` (container not found)
- `docker logs --tail=120 ghost-control-plane` (container not found)
- Actual active containers for this stack were `ghoststack-rag-agent-ingress-1` and `ghoststack-rag-control-api-1`; tailed both logs.

## Human browser run

### What was observed in browser

- Ghost ChatUI loaded successfully in browser view `ac7c7a`.
- A UI interaction regression exists in the compact view: agent/conversation list clicks were repeatedly intercepted by overlapping non-interactive layers, which prevented reliable manual selection of `Finance Agent` from that specific viewport.
- A second browser view (`24b582`) rendered full-width but showed `No active agent is currently available from GhostDASH configuration`, which blocked message send in that tab.

### Practical execution path used

To complete the requested validation without guessing and while still grounding in live stack behavior, the test turn was executed directly against the same streaming endpoint used by Ghost ChatUI:

- Endpoint: `POST /agent/chat/stream`
- Payload file: `/tmp/finance_prompt_payload.json`
- Stream capture: `/tmp/finance_stream_run1.txt`
- Persisted conversation fetch: `/tmp/finance_conv_messages.json`

## Exact request body sent

```json
{
  "message": "Using Odoo, Show me GP/ROAS/performance and any relevant financial / assessment data for the previous 7 days from the 20/04/2026 for the BUSINESS Ride Electric Burleigh ONLY.",
  "corpora": ["re-finance26"],
  "api_mode": "chat_completions",
  "conversation_mode": "board",
  "workflow_mode": "standard",
  "agent_id": "0488d744-c66c-4d0e-9a29-c68fa81ba84f",
  "conversation_id": null,
  "use_approved_web": false,
  "odoo_agentic": true
}
```

## What the model path actually received (evidence)

- Start event included:
  - `conversation_mode: "board"`
  - `agent_id: "0488d744-c66c-4d0e-9a29-c68fa81ba84f"` (Finance Agent)
  - `cached: false`
  - Tool plan requiring `odoo.finance.margin.period_summary`
- Tool execution event confirmed live Odoo call:
  - `date_from: "2026-04-13"`
  - `date_to: "2026-04-20"`
  - `company_id: 5`
  - `company_scope_lock_canonical: "burleigh"`
  - `scope_enforced: true`
- Persisted user message for conversation `49907352-4d74-48e7-bc09-a696c4dc3716` exactly matched the requested prompt text.

## Answer quality evaluation

### Passes

- Burleigh-only scope was enforced by Odoo tool payload (`company_id: 5`, scope lock canonical `burleigh`).
- GP/performance data was returned with explicit Revenue/COGS/GP/GP%.
- ROAS was not fabricated; answer declared data gap.
- Odoo provenance existed (tool result citation and execution payload).
- `cached` flag for this run was `false`.

### Gaps / defects

1. Date interpretation risk:
   - Answer treated window as `2026-04-13` through `< 2026-04-20` in source domains (exclusive upper bound),
   - but prose states “April 13, 2026 – April 20, 2026,” which can be read as inclusive and is misleading.
2. Currency formatting inconsistency:
   - Finance runtime contract says `A$X,XXX.XX`, but answer used `$` not `A$`.
3. Corrupted sentence appears in executive summary:
   - `Request morre information iif it iss nnot possiible to rrersspond accurately to my question.`
   - This looks like malformed guardrail questionnaire text leaking into final output.
4. Browser UI reliability issue:
   - Agent/conversation click interception in compact viewport prevents trustworthy human operator interaction.

## Cache transparency implementation completed

To remove ambiguity for operators, Ghost ChatUI now surfaces cache status in-message:

- Added `cached?: boolean` to message types and API response typing.
- Mapped persisted `cached` into UI message model.
- Threaded stream `cached` from `onStart` and `onDone` into the assistant message state.
- Added visible “cached” metadata tag and a dedicated “Cached response” notice card in message bubbles.

Changed files:

- `/var/Ghost-chatUI/src/lib/types/chat.ts`
- `/var/Ghost-chatUI/src/lib/providers/api.ts`
- `/var/Ghost-chatUI/src/lib/state/useGhostChat.ts`
- `/var/Ghost-chatUI/src/components/chat/MessageBubble.tsx`

Validation:

- `npm run lint` passed
- `npm run test` passed (14 files, 17 tests)

## Cache misuse decision

- Reproduction did **not** show stale cache replay for this Odoo/board request (`cached: false` with live tool execution).
- Therefore no backend cache-policy hardening change was applied in this pass.

## Recommended next fixes

1. Fix malformed guardrail text in Finance Agent runtime profile (`morre/iif/...`) to prevent prompt contamination.
2. Clarify and enforce inclusive/exclusive date wording in response templates so prose matches exact query domain bounds.
3. Fix compact-layout click interception in Ghost ChatUI so agent/conversation selection remains operable at narrow widths.

## Prompt hardening + comparison retest (Burleigh vs Brisbane)

### Hardening applied

Backend prompt construction was hardened in `backend/src/ghostdash_api/agent_ingress.py`:

- Added `_sanitize_owner_operator_template()` to strip `Source template hashable text: ...` tails.
- `build_owner_operator_questionnaire_directives()` now:
  - uses sanitized owner-operator intent text only,
  - adds explicit rule to never echo template wording in final answers.
- `build_runtime_context_block()` now uses sanitized owner-operator compact guidance, preventing malformed questionnaire text from entering runtime context.

Regression tests added/updated in `backend/tests/test_agent_ingress_prompt_hotfix.py` and passed.

### Comparison retest prompt

`Using Odoo, compare Burleigh over Brisbane for GP/ROAS/performance and any relevant financial / assessment data for the previous 7 days from the 20/04/2026.`

Payload file: `/tmp/finance_compare_payload.json`  
Stream capture: `/tmp/finance_compare_stream2.txt`

### Retest outcome

- Stream `start`/`done` both showed `cached: false`.
- Live Odoo evidence executed:
  - `odoo.rpc.search_read` to resolve Burleigh/Brisbane company IDs
  - `odoo.finance.margin.monthly_comparison` for both entities
- Returned comparison metrics (13/04/2026 to 20/04/2026 window):
  - Burleigh: Revenue `61,003.47`, COGS `41,549.02`, GP `19,454.45`, GP% `31.89%`
  - Brisbane: Revenue `23,074.70`, COGS `21,369.31`, GP `1,705.39`, GP% `7.39%`
- The malformed phrase (`morre/iif/...`) no longer appeared in the final response after hardening.
- Remaining quality gaps:
  - Currency format still uses `$` instead of strict `A$`.
  - Date wording still presents an inclusive-looking range while domains use `< 2026-04-20`.

## Verify commands

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-agent-ingress-1
docker logs --tail=120 ghoststack-rag-control-api-1
cat /tmp/finance_prompt_payload.json
cat /tmp/finance_stream_run1.txt
cat /tmp/finance_conv_messages.json
```
