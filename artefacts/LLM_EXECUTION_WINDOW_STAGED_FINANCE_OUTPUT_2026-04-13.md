## Context

We observed chat runs returning the fallback text:

- `Insufficient execution window warning: ... the model timed out before it could finish a full long-form answer.`

On inspection, this fallback could be triggered by **any upstream error that produced an empty answer**, including hard context-window validation failures (not only timeouts).

Separately, runtime logs showed the system was attempting to request **`max_output_tokens=16000`**, which can immediately fail on smaller-context models (example: 8k context).

## Evidence

- Docker service logs showed upstream rejection like:
  - model max context 8192 tokens
  - requested: prompt + completion = 18956 tokens (completion=16000)

## Root causes

- **Unbounded max tokens for “responses” mode on OpenAI-compatible gateways**:
  - `resolve_answer_max_tokens()` only clamped when `api_mode == "chat_completions"`.
  - When `api_mode == "responses"` but the call was *not* OpenAI native `/v1/responses`, the system could pass huge `max_tokens` through the OpenAI-compatible wrapper.

- **Default runtime profile max tokens too high**:
  - `DEFAULT` runtime profile config defaulted to `max_tokens=16000`, encouraging oversized output requests by default.

- **Fallback misclassification**:
  - Context-length errors and other upstream errors were often being surfaced as the “execution window” warning.

## Fix implemented

### 1) Safer max token resolution for all chat calls

- `resolve_answer_max_tokens()` now takes `openai_responses_chain: bool` and returns `int | None`.
- **OpenAI native `/v1/responses` chain**:
  - If configured `max_tokens` is too large, we **omit** `max_output_tokens` entirely to avoid immediate validation failure.
- **All other OpenAI-compatible chat calls (local gateways, LlamaIndex OpenAI wrapper)**:
  - We always clamp using:
    - a safe completion cap (`CHAT_COMPLETIONS_COMPLETION_TOKEN_CAP`)
    - available context estimate (`8192 - prompt_estimate - safety`)

### 2) Staged finance output for Odoo finance investigations

When the tool plan operation starts with `odoo.finance.` we append answer constraints:

- first pass: executive summary + month-to-month changes + top drivers
- keep concise (bullets + small table)
- end with “Say CONTINUE for deeper drill-down…”

This prevents the model from trying to write a full strategic paper in one go and improves perceived responsiveness in UI streaming.

### 3) Better error classification for fallbacks

We now distinguish:

- length guardrail errors
- context window errors (maximum context length exceeded)
- timeout errors

So the user sees the correct remediation guidance instead of an incorrect “execution window” warning for every upstream failure.

### 4) Longer default upstream LLM request timeout

Added `app_llm_request_timeout_seconds` (default `300.0`) and applied it to the OpenAI client used for OpenAI-compatible HTTP calls.

## Files changed

- `backend/src/ghostdash_api/agent_ingress.py`
- `backend/src/ghostdash_api/runtime.py`
- `backend/src/ghostdash_api/runtime_profiles.py`
- `backend/src/ghostdash_api/settings.py`
- `backend/src/ghostdash_api/schemas.py`
- `backend/tests/test_agent_ingress_prompt_hotfix.py`

## Acceptance criteria

- Finance investigations (e.g. Retail COGS July/Aug/Sep 2025) **stream a concise first answer** without hitting the “execution window warning”.
- The system does **not** request absurd output token sizes (ex: 16000) against 8k-context models.
- When context size is exceeded, the user sees a **context-window exceeded** message (not a timeout warning).

## Verify

1) Run backend tests:

```bash
python3.12 -m pytest -q backend/tests/test_agent_ingress_prompt_hotfix.py backend/tests/test_agent_memory_tool_history.py backend/tests/test_workflows_odoo_planning.py backend/tests/test_tools_api.py
```

2) Tail `agent-ingress` logs while running the finance query and confirm no `max_output_tokens=16000` style failure:

```bash
docker logs --tail=200 ghoststack-rag-agent-ingress-1
```

