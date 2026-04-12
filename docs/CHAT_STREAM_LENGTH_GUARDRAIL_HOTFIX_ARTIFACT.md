# Chat Stream Length Guardrail Hotfix Artifact

## Summary

This hotfix hardens `agent-ingress` against oversized answer prompts that were causing `/agent/chat/stream` to begin SSE, then fail mid-stream with:

`openai.UnprocessableEntityError: Error code: 422 - {'detail': 'guardrail: input exceeds max length'}`

The fix keeps `/agent/chat` and `/agent/chat/stream` aligned on the same prompt-compaction logic, retries the stream path once with a smaller prompt when the failure is a prompt-length guardrail rejection, clamps `chat_completions` completion size to fit the upstream model context window, and emits a clean fallback SSE response with `done` instead of leaving the browser UI in a broken state.

## Failure Seam

Observed runtime seam:

1. `workflow-runtime` succeeds and returns a grounded query plan.
2. `agent-ingress` builds the answer prompt in `backend/src/ghostdash_api/agent_ingress.py`.
3. `stream_answer(...)` in `backend/src/ghostdash_api/runtime.py` starts the streaming request.
4. Upstream rejects the prompt with a 422 guardrail length error.
5. SSE had already started, so the browser looked hung or broken when the generator raised.

## Files Changed

- `backend/src/ghostdash_api/agent_ingress.py`
- `backend/tests/test_agent_ingress_prompt_hotfix.py`
- `docs/CHAT_STREAM_LENGTH_GUARDRAIL_HOTFIX_ARTIFACT.md`

## Implementation Detail

### 1. Shared answer-prompt budgeting

`agent_ingress.py` now prepares compacted prompt variants through shared helpers used by both routes:

- api-mode-aware primary prompt budget
- api-mode-aware retry prompt budget
- user-question-preserving query prompt trimming
- history-first trimming so grounded query context wins over older conversation memory

Key behaviors:

- the user question is preserved at the tail of the compacted query prompt whenever trimming occurs
- older conversation history is trimmed before grounded query context
- approved web context and upload context remain available, but are compacted before the final query section is reduced too aggressively
- `chat_completions` uses a head-biased query-context trim so the earliest retrieved evidence survives while the user question stays intact at the tail
- the duplicate inline copy of the system prompt is no longer embedded into the user prompt body; the system prompt is still sent through the model system channel

Current budget behavior:

- `responses.primary`: `max_total_chars=18000`, `max_history_chars=1200`, `max_query_chars=9000`
- `responses.retry`: `max_total_chars=12000`, `max_history_chars=400`, `max_query_chars=6500`
- `chat_completions.primary`: `max_total_chars=5200`, `max_history_chars=300`, `max_query_chars=3600`
- `chat_completions.retry`: `max_total_chars=2800`, `max_history_chars=0`, `max_query_chars=1800`

This gives `chat_completions` a materially smaller retry path and drops history entirely on retry.

### 2. Stream-safe retry and fallback

For `/agent/chat/stream`:

1. Start SSE normally.
2. If the first stream attempt fails with a length guardrail error before any delta is sent:
   - rebuild using the retry budget
   - retry once
3. If the retry still fails:
   - emit a useful fallback delta
   - emit `done`
   - avoid crashing the SSE generator

This keeps the browser experience intact even when the upstream provider still refuses the prompt.

### 3. Chat Completions Completion Clamp

Live verification exposed a second narrow failure after the tighter prompt budget cleared the original guardrail:

- upstream model context window: `8192` tokens
- configured `chat_completions` `max_tokens`: `16000`

`agent_ingress.py` now clamps `chat_completions` completion size before generation. For the real failing prompt, the live route resolved:

- configured `max_tokens=16000`
- resolved `max_tokens=1536`

This is logged via `chat_answer.max_tokens_clamped`.

### 4. Synchronous route alignment

`/agent/chat` now uses the same compacted prompt preparation logic as `/agent/chat/stream`, so the non-streaming and streaming routes do not drift in prompt shape or trimming behavior.

### 5. Observability

New telemetry is emitted for:

- prompt compaction
- chat-completions max-token clamping
- stream retry after a length error
- stream fallback after repeated length rejection
- sync fallback after repeated length rejection

This makes the degraded path visible in logs without requiring browser reproduction.

### 6. Cache protection

Synthetic fallback responses are not cached. This prevents a transient or provider-specific failure from becoming a sticky cached response for later identical requests.

## Targeted Tests Added

`backend/tests/test_agent_ingress_prompt_hotfix.py`

Coverage:

- prompt compaction trims history before grounded query context and preserves the user question
- `chat_completions` budgets are tighter than `responses`, and retry drops history entirely
- `/agent/chat` uses the compacted prompt path
- `/agent/chat` and `/agent/chat/stream` clamp `chat_completions` `max_tokens`
- `/agent/chat/stream` retries once with a smaller prompt when the first attempt hits the length guardrail
- `/agent/chat/stream` emits a clean fallback and `done` when both attempts fail

## Verification Run

### Automated

Command run:

```bash
docker run --rm -v /var/llamaindex/ghoststack-rag/backend:/app -w /app ghoststack-rag-agent-ingress /bin/sh -lc "pip install --no-cache-dir pytest >/tmp/pytest-install.log && PYTHONPATH=/app/src python -m pytest tests/test_agent_ingress_prompt_hotfix.py"
```

Result:

- `5 passed in 3.70s`

### Service rollout

Command run:

```bash
docker compose up -d --build agent-ingress
```

Result:

- `agent-ingress` rebuilt and restarted successfully
- `workflow-runtime` was recreated as part of the compose rebuild path
- public health remained `{"status":"ok"}`

### Human/browser validation

Live browser validation was run against:

- `https://ghoststack.rideai.com.au/chat`

Observed result after the tightened rebuild:

- uncached live `POST /agent/chat/stream` with the exact failing prompt returned a real streamed answer instead of the fallback
- the persisted assistant message for that new conversation contains the generated answer body, not the fallback text
- agent-ingress logs showed:
  - `chat_completions.primary` prompt compaction from `7278` chars to `4408`
  - `chat_answer.max_tokens_clamped` from `16000` to `1536`
  - `openai.chat_completions.stream` completed with `status: "ok"`
- browser `/chat` verification rendered a real answer card instead of the fallback card

Note:

- the browser follow-up used the successful live answer already generated for that exact prompt, so the UI displayed the real answer immediately
- the uncached direct stream verification is the proof point that the generation path itself now clears the previous failure mode

## Acceptance Criteria

- oversized prompts no longer crash the streaming SSE generator
- the browser receives a clean terminal state (`done`) even when upstream rejects the prompt twice
- the user question is preserved in the compacted query prompt
- sync and stream chat routes share the same prompt-compaction path
- `chat_completions` completion size is clamped to the upstream context window instead of inheriting an invalid `16000` token target
- the failure mode is observable in agent-ingress logs

## Exact Verify Commands

```bash
docker run --rm -v /var/llamaindex/ghoststack-rag/backend:/app -w /app ghoststack-rag-agent-ingress /bin/sh -lc "pip install --no-cache-dir pytest >/tmp/pytest-install.log && PYTHONPATH=/app/src python -m pytest tests/test_agent_ingress_prompt_hotfix.py"
```

```bash
docker compose up -d --build agent-ingress
```

```bash
curl -sf http://127.0.0.1/health
```

```bash
docker logs --tail=120 ghoststack-rag-agent-ingress-1
```

```bash
curl -sS -N https://ghoststack.rideai.com.au/agent/chat/stream -H 'Content-Type: application/json' --data '{"message":"Build a grounded executive summary covering the Queensland law change, the projected 4-6 million turnover risk, exposed product categories, and FY26 response options. Keep it concise but evidence-based.","agent_id":"2564d0e0-4cf3-4dab-8e78-91c6e4daf9cc","api_mode":"chat_completions"}'
```

## Caveat

This tightening materially improves the real-answer path for `chat_completions`, but it does not guarantee every large grounded request will succeed. The remaining risk is answer quality versus compactness: tighter `chat_completions` budgets trade breadth of retrieved context for reliability and completion within the upstream context window.
