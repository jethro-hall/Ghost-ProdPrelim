## Goal
Record token usage at the final provider boundary whenever the provider reports it, and persist per-turn usage with the assistant message.

## Previous state
- `agent_ingress` estimated usage after generation with `estimate_llm_turn_usage_dict()`
- `runtime.py` returned text and sometimes `openai_response_id`, but not provider usage
- UI sidebar totals were transient and conversation history did not preserve per-turn usage

## Current contract
### Final-hop first
`backend/src/ghostdash_api/runtime.py` now returns `LlmCompletionResult.usage` when the provider exposes usage metadata:
- OpenAI chat completions
- OpenAI responses
- Gemini native `usageMetadata`

### Fallback estimation
If the provider does not expose usage, GhostDASH falls back to estimated usage:
- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `estimate: true`

### Persistence
Assistant turns persist `usage_json` on `agent_messages`.
This makes historical conversation reloads source token totals from stored turns instead of a volatile UI counter.

### UI behavior
The sidebar total is still an aggregate, but it is now rebuilt from persisted per-message usage on conversation load.

## Important distinction
- `estimate: false`: provider-reported usage from the last hop
- `estimate: true`: local fallback estimate

This contract is per final answer turn, not “all attempts including retries”.

## Known boundary
Retry/fallback attempt accounting is still separate from the final user-visible turn total.
That is deliberate to avoid double counting.

## Verify
```bash
pytest backend/tests/test_agent_ingress_prompt_hotfix.py -q
```

```bash
python3.12 -m compileall backend/src
```

