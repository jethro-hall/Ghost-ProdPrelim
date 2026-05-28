# Chat answer fallbacks (agent-ingress)

When the user sees an assistant message that **does not** read like a normal model answer, it may be a **server-built fallback** string. These are **not** model-generated prose; they explain what failed and what to try next.

**Implementation:** `backend/src/ghostdash_api/agent_ingress.py` — functions `build_blank_answer_fallback`, `build_timeout_fallback`, `build_length_guardrail_fallback`, `build_context_length_fallback`.

**Design rules (2026-04-17 refresh):**

- Copy is **domain-neutral**. Do not embed scenario-specific examples (e.g. a jurisdiction, FY year, or dollar figure) that could be mistaken for retrieved facts.
- Prefer **What we know** / **What to try** so operators and end users can triage without reading Python.
- Citation counts refer to **structured citation objects** passed into the builder; retrieval may still have run even when generation returns empty text.

## When each fallback is used

| Fallback | Typical trigger | Distinctive meaning |
|----------|------------------|---------------------|
| **Blank** | After both non-streaming and streaming generation attempts, `answer` is still empty/whitespace, and the error is **not** classified as length guardrail, context window, or timeout. | Empty or unparsed model output, or an unclassified provider error. Citations may still be non-empty. |
| **Timeout** | Classified timeout (`is_timeout_error`). | Latency / execution window; not “bad data.” |
| **Length guardrail** | Provider message matches length guardrail heuristics (`is_length_guardrail_error`). | Prompt too long **after** retrieval; provider rejected before or during completion. |
| **Context length** | Message matches context window heuristics (`is_context_length_error`). | Total tokens (prompt + completion budget) exceed model limits. |

## Operational notes

- **Blank + many citations** usually means **retrieval succeeded** but **generation did not** return displayable text. Check provider logs, model id, API mode, and whether the completion body was empty or filtered.
- **Streaming path** (`/chat/stream`) appends the same fallback text as a final delta when `answer_parts` is still empty after errors (see `chat_stream.*` routes in the same module).

## Verify

```bash
python -m compileall -q /var/llamaindex/ghoststack-rag/backend/src/ghostdash_api/agent_ingress.py
```

Run targeted tests if touching ingress behavior:

```bash
cd /var/llamaindex/ghoststack-rag/backend && pytest backend/tests/test_agent_ingress_prompt_hotfix.py -q
```

(Adjust path if your test layout differs.)
