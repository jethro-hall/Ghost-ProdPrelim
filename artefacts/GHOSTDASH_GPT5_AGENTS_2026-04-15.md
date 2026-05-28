## Goal
Create two new GhostDASH agents that both run on the **OpenAI GPT-5 family** model exposed by your staging gateway (canonical id in-repo: `openai/gpt-5.4`, outbound `gpt-5.4` after normalization). The earlier placeholder `gpt-5.2-pro` was rejected upstream (404).

1) **GPT-5 Data Collector**: collaborative Q&A agent to extract the minimum required business + finance evidence.
2) **GPT-5 Documenter**: board-ready document writer with strong Ghost Chat formatting discipline (tables, headings, clean AUD currency formatting).

## What was created (persisted in Control API / DB)
Agents:
- `GPT-5 Data Collector` (agent_id: `2dd8526f-58ac-4ad1-af61-b62dc787b4de`)
- `GPT-5 Documenter` (agent_id: `38d22bff-9957-4a1f-99e6-27c0c2037d66`)

Both agents:
- Provider connection: `openai-staging`
- Connection id: `be77912a-3bbe-4227-82ca-912f94b827b2` (OpenAI Staging)
- Model id: `openai/gpt-5.4` (repaired automatically from `gpt-5.2-pro` on seed/bootstrap; see `agent_memory._repair_gpt5_agent_deprecated_models`)
- API mode: `responses`

## Runtime behavior
### GPT-5 Data Collector
- Conversation mode: `working_session`
- Tools:
  - KB: enabled
  - Approved Web: enabled
  - Odoo: enabled
- Prompt intent:
  - minimize question set
  - capture structured facts + numbers
  - never invent missing figures
  - default AUD formatting
  - end each turn with: learned / missing / next question

### GPT-5 Documenter
- Conversation mode: `board`
- Tools:
  - KB: enabled
  - Approved Web: enabled
  - Odoo: disabled
- Prompt intent:
  - board-ready structure
  - clean headings + compact tables
  - explicit facts vs assumptions vs recommendations
  - placeholders when data is missing (no bluffing)

## Acceptance criteria
1) Both agents appear in Agent Configuration and Chat agent pickers.
2) Both agents show `model_id = openai/gpt-5.4` (or equivalent supported id on your gateway) and `provider = openai-staging`.
3) Starting a new conversation with either agent uses that model for the next message.

## Verify (commands)
List agent model configs:

```bash
python3 - <<'PY'
import json, urllib.request
agents=json.loads(urllib.request.urlopen('http://localhost/api/agents', timeout=10).read())
for a in agents:
    llm=(a.get('runtime_profile') or {}).get('llm_config') or {}
    if a.get('name') in {'GPT-5 Data Collector','GPT-5 Documenter'}:
        print(f\"{a.get('id')}\\t{a.get('name')}\\t{llm.get('provider')}\\t{llm.get('model_id')}\\t{llm.get('connection_id')}\")
PY
```

Human verify (UI):
- Open GhostDASH → Agent Configuration:
  - Select each agent → confirm Connection = OpenAI Staging and Model id = `openai/gpt-5.4` (or the id your gateway documents)
- Open Ghost Chat:
  - Start a new conversation with each agent and send a short prompt; confirm a response is generated.

