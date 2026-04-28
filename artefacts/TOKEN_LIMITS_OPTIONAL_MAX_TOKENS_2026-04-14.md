# Optional `max_tokens` (remove 16k cap) — 2026-04-14

## Goal
- Remove the **hard 16,000 `max_tokens` limit** imposed by UI + backend validation.
- Make `max_tokens` **optional**:
  - **blank / null** means **"auto / provider default"**
  - if provided, GhostDASH passes it through as a provider hint (provider enforces actual limits)

## What changed (source of truth)
- **Backend**
  - `backend/src/ghostdash_api/schemas.py`
    - `RuntimeProfileLlmConfig.max_tokens`: changed from required int with `<=16000` to `int | None`
  - `backend/src/ghostdash_api/agent_ingress.py`
    - `resolve_answer_max_tokens`: now returns `None` when unset, and does not clamp to a fixed cap
  - `backend/src/ghostdash_api/runtime.py`
    - OpenAI-compatible `chat.completions.create(...)`: only sends `max_tokens` when not null

- **UI**
  - `ui/src/pages/AgentConfigPage.tsx`
    - Default runtime profile uses `max_tokens: null`
    - Input allows empty value (`placeholder: auto`)
    - Validation now accepts blank or `>= 1`
  - `ui/src/api.ts`
    - Type updated to allow `max_tokens?: number | null`

## Acceptance criteria
- Operator can save a runtime profile with:
  - `max_tokens = null` (blank in UI), and chats still succeed
  - `max_tokens > 16000` without validation rejection

## Verify commands
```bash
curl -fsS http://localhost/api/agents | jq '.[] | select(.is_default==true) | .runtime_profile.llm_config | {provider,model_id,api_mode,max_tokens,connection_id}'

# Save blank max_tokens (null) for default agent runtime profile
AGENT_JSON="$(curl -fsS http://localhost/api/agents | jq -c '.[] | select(.is_default==true)')"
AGENT_ID="$(echo "$AGENT_JSON" | jq -r '.id')"
PAYLOAD="$(echo "$AGENT_JSON" | jq -c '
  {
    id,
    name,
    first_message,
    language,
    voice_id,
    is_default,
    enabled,
    runtime_profile: (
      .runtime_profile
      | del(.created_at,.updated_at)
      | .llm_config.max_tokens = null
    )
  }'
)"
curl -fsS -X POST http://localhost/api/agents -H 'content-type: application/json' -d "$PAYLOAD" | jq '.runtime_profile.llm_config | {provider,model_id,api_mode,max_tokens}'

# End-to-end chat should still work
curl -fsS -X POST http://localhost/agent/chat \
  -H 'content-type: application/json' \
  -d "{\"agent_id\":\"$AGENT_ID\",\"message\":\"Return exactly: OK\",\"corpora\":[],\"top_k\":4,\"api_mode\":\"responses\"}" \
  | jq '{answer,cached,usage}'
```

