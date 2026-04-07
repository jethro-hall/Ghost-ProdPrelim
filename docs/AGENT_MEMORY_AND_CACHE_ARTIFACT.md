## Agent Memory And Cache Artifact

### Goal

Add native conversation remembering and native cache behavior on a per-agent basis without introducing extra infrastructure outside the existing GhostDASH stack.

### Architectural choice

Use the existing Postgres-backed application database as the system of record for:

- agent profiles
- agent conversations
- agent messages
- exact-match per-agent chat response cache

Why:

- Postgres is already in the live stack
- per-agent memory must survive browser reloads and service restarts
- this avoids in-browser/localStorage drift for the core memory path
- this avoids introducing Redis or another cache service before it is operationally necessary

### Implemented backend model

New persisted records in [`backend/src/ghostdash_api/models.py`](../backend/src/ghostdash_api/models.py):

- `AgentProfileRecord`
- `AgentConversationRecord`
- `AgentMessageRecord`
- `ChatResponseCacheRecord`

Related helper module:

- [`backend/src/ghostdash_api/agent_memory.py`](../backend/src/ghostdash_api/agent_memory.py)

This module now owns:

- seeding the default agent profile
- listing/saving agent profiles
- listing conversations and messages
- building recent conversation context
- exact-match response-cache lookup/store

### Implemented API surface

New/extended API behavior:

- `GET /api/agents`
- `POST /api/agents`
- `GET /api/agents/{agent_id}/conversations`
- `GET /api/conversations/{conversation_id}/messages`
- `POST /agent/chat` now accepts:
  - `agent_id`
  - `conversation_id`
- `POST /agent/chat/stream` now accepts:
  - `agent_id`
  - `conversation_id`

Chat responses now return:

- `conversation_id`
- `agent_id`
- `cached`

### Runtime behavior

Updated [`backend/src/ghostdash_api/agent_ingress.py`](../backend/src/ghostdash_api/agent_ingress.py):

- selects the requested agent profile or default agent
- creates a conversation when one does not yet exist
- loads recent conversation messages for that agent/conversation
- builds recent-memory context into the prompting path
- persists user + assistant messages
- uses an exact-match response cache keyed by:
  - agent identity/config
  - recent conversation context
  - current message
  - corpora
  - API mode

Updated [`backend/src/ghostdash_api/runtime.py`](../backend/src/ghostdash_api/runtime.py):

- allows agent-specific overrides for:
  - system prompt
  - model id
  - temperature
  - max tokens

### UI behavior

Updated:

- [`ui/src/pages/AgentConfigPage.tsx`](../ui/src/pages/AgentConfigPage.tsx)
- [`ui/src/components/GhostChat.tsx`](../ui/src/components/GhostChat.tsx)
- [`ui/src/api.ts`](../ui/src/api.ts)
- [`backend/src/ghostdash_api/control_api.py`](../backend/src/ghostdash_api/control_api.py)

Operator-facing outcome:

- Agent Configuration page now loads/saves persisted agents from the backend
- multiple agents can be viewed and selected
- GhostChat now exposes:
  - agent selector
  - conversation selector
  - new conversation option
- conversation lists are distinct per agent
- remembered message history is restored through the API

### Verification performed

API verification:

- `GET /api/agents`: passed
- `POST /api/agents` with `Finance Agent`: passed
- `POST /agent/chat`: passed
- `GET /api/agents/{agent_id}/conversations`: passed
- `GET /api/conversations/{conversation_id}/messages`: passed

Observed live API outcomes:

- default agent and `Finance Agent` persist separately
- each agent gets its own conversation list
- the default agent conversation stored 4 messages after two turns
- follow-up question in the same conversation returned:
  - `Customer is RideAI ...`

That demonstrates remembered context is being carried on a per-agent conversation basis.

Browser verification:

- Agent Configuration page shows:
  - `GhostDASH Assistant`
  - `Finance Agent`
- GhostChat shows:
  - agent selector
  - conversation selector
  - distinct conversation lists per agent
- no visible UI errors were reported during browser verification

### Residual risk

The response cache is exact-match and context-hash based. That is intentional for correctness, but it means:

- cache hits are strongest for repeated prompts with the same recent context
- changing recent conversation history changes the cache key
- this is good for correctness, but it is not semantic cache reuse

If you later want broader answer reuse, the next step would be a semantic response cache with explicit invalidation against corpus/document updates.

### Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 -m compileall backend/src
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
curl -sS http://localhost/api/agents
curl -sS http://localhost/api/runtime/defaults
```

```bash
python3.12 - <<'PY'
import json, urllib.request
base='http://localhost'
agents=json.loads(urllib.request.urlopen(base+'/api/agents', timeout=120).read().decode())
default_agent=next(agent for agent in agents if agent['is_default'])
payload={'message':'What is amount for RideAI?','corpora':['xlsx-native-1775456954'],'api_mode':'responses','agent_id':default_agent['id']}
req=urllib.request.Request(base+'/agent/chat', data=json.dumps(payload).encode(), headers={'Content-Type':'application/json'}, method='POST')
first=json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
payload['conversation_id']=first['conversation_id']
payload['message']='What customer was I just asking about?'
req=urllib.request.Request(base+'/agent/chat', data=json.dumps(payload).encode(), headers={'Content-Type':'application/json'}, method='POST')
second=json.loads(urllib.request.urlopen(req, timeout=120).read().decode())
print('FIRST', json.dumps(first))
print('SECOND', json.dumps(second))
print('CONVERSATIONS', urllib.request.urlopen(base+f"/api/agents/{default_agent['id']}/conversations", timeout=120).read().decode())
print('MESSAGES', urllib.request.urlopen(base+f"/api/conversations/{first['conversation_id']}/messages", timeout=120).read().decode())
PY
```
