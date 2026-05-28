# Human E2E: Genuine business question (2026-04-22)

## What was tested

- **URL:** `https://ghoststack.rideai.com.au/agent`
- **Chat:** GhostChat, agent **Business Strategist**, **New conversation**
- **Prompt:** Compare Burleigh vs Brisbane in March; revenue, gross margin %, COGS, net profit, ROAS; top gap driver; what to watch next month.

## Observed behavior (UI)

- **Odoo:** `odoo.rpc.search_read` **executed** (~1.5s)
- **Odoo:** `odoo.finance.pnl.period_summary` **executed** (~1.6s), metadata included `window:2026-03-01->2026-04-01` and `companies:4,5` (branch scope and period parsing reached live Odoo).
- **Sub-agent:** Legend stayed on **Planned** for `agent.case_framing_agent.execute`; send button remained disabled for an extended period.

## Server evidence (this host)

- **Container:** `ghoststack-rag-agent-ingress-1`
- **Log line (JSON):** `route: "openai.responses"`, `latency_ms` ~273264, `status: "error"`,  
  `error: InternalServerError("Error code: 504 - {'detail': 'upstream llm timeout'}")`  
  (same trace as `/agent/chat/stream` for this session).

## Verdict

- **Data / routing:** Genuineness of the question is exercised; Odoo path and period/company scope work.
- **Synthesis:** Final answer not obtained in-UI; failure mode matches **upstream LLM timeout (504)** on the **Responses** path, not a missing business-structure gate for this prompt (branches were explicit).

## Code fix (2026-04-22 follow-up)

- `app_llm_request_timeout_seconds` default raised to **900**; `LlamaIndexOpenAI` now receives the same timeout (was default 60s in the library).
- **Responses → Chat Completions** automatic fallback on 504 / upstream LLM timeout / read timeout when `app_llm_responses_fallback_to_chat` is true (default) and `previous_response_id` is not used (so chain is not broken).
- Sub-agent completion now defaults `max_tokens` to **`app_sub_agent_max_output_tokens_default` (4096)** when the worker profile omits it, bounding worst-case generation latency.

## Re-verify (authenticated)

```bash
# Replace <conversation_id> with the id shown in the UI or network tab after send completes
curl -sS "https://ghoststack.rideai.com.au/api/conversations/<conversation_id>/messages" | python3 -m json.tool
```

Unauthenticated curl returns `[]` for protected conversations.

## Acceptance

- [ ] Authenticated message fetch shows assistant content **or** explicit error (not only empty placeholder).
- [ ] Ingress logs show no `504` / `upstream llm timeout` for the same run after infra/model tuning (raise gateway timeout, use faster model for case framing, or move framing off Responses if appropriate).
