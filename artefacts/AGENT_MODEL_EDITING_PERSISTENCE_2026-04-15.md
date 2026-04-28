## Problem
Operator edits to an agent's runtime model (and other runtime profile fields) did not persist reliably.

Observed symptom:
- Updating `runtime_profile.llm_config.model_id` via the Agent Config UI appeared to save, but after refresh / reloading agents it reverted to the previous value.

## Root cause (truth-first)
The backend runs `seed_default_agent_profiles(session)` during common codepaths (`/api/agents`, `/agent/chat`, etc.).

For the seeded "special" agents (Business Strategist / Documenter / Odoo Specialist), `seed_default_agent_profiles` was **re-applying** the canned `specialized_runtime_profile_payload(...)` on every call. This overwrote operator edits, including `llm_config.model_id`.

## Fix
Change seeding semantics:
- Seeding must ensure the default agent and special agents exist.
- Seeding must **not** overwrite existing runtime profiles/agents (operator-owned configuration).

Implementation:
- In `backend/src/ghostdash_api/agent_memory.py`, `seed_default_agent_profiles` now:
  - prefers the runtime profile already attached to the existing agent (stable by `runtime_profile_id`)
  - otherwise reuses an existing runtime profile by name
  - only creates a new runtime profile if missing
  - never re-writes an existing runtime profile payload during seeding

## Acceptance criteria
1) In Agent Config UI, changing "Model id" and saving persists.
2) Refreshing the page keeps the new model id.
3) Subsequent `/api/agents` calls do not revert the model id.

## Verify (commands)
Print agent models:

```bash
python3 - <<'PY'
import json, urllib.request
agents=json.loads(urllib.request.urlopen('http://localhost/api/agents', timeout=10).read())
for a in agents:
    llm=(a.get('runtime_profile') or {}).get('llm_config') or {}
    print(f"{a.get('name')}\t{llm.get('provider')}\t{llm.get('model_id')}")
PY
```

Update a specific agent model and confirm persistence (example: Business Strategist):

```bash
python3 - <<'PY'
import json, urllib.request
AGENT_NAME='Business Strategist'
NEW_MODEL='openai/gpt-4o-mini'

agents=json.loads(urllib.request.urlopen('http://localhost/api/agents', timeout=10).read())
agent=next(a for a in agents if a.get('name')==AGENT_NAME)

payload={k:agent[k] for k in ['id','name','first_message','language','voice_id','runtime_profile_id','is_default','enabled']}
payload['runtime_profile']=agent['runtime_profile']
payload['runtime_profile']['llm_config']=dict(payload['runtime_profile'].get('llm_config') or {})
payload['runtime_profile']['llm_config']['model_id']=NEW_MODEL

req=urllib.request.Request(
  'http://localhost/api/agents',
  data=json.dumps(payload).encode('utf-8'),
  headers={'Content-Type':'application/json'},
  method='POST'
)
saved=json.loads(urllib.request.urlopen(req, timeout=10).read())
print('saved:', saved['runtime_profile']['llm_config']['model_id'])

agents2=json.loads(urllib.request.urlopen('http://localhost/api/agents', timeout=10).read())
agent2=next(a for a in agents2 if a.get('name')==AGENT_NAME)
print('listed:', agent2['runtime_profile']['llm_config']['model_id'])
PY
```

