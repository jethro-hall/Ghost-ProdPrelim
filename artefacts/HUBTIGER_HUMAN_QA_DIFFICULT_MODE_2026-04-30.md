# Hubtiger Human QA (Difficult Mode) - 2026-04-30

## Requirement

Validate production-readiness behavior for ambiguous common-name searches, store-scoping safety, and no-cache retry workflow from a human-operator perspective.

## Scenarios executed

Used common-name collisions via local operator endpoint (`/api/hubtiger/test`) after rebuilding `control-api`:

1. `Sarah Lee` with requested store:
   - `southport`
   - `brisbane`
   - `burleigh`
2. `John Smith` with requested store:
   - `southport`
   - `brisbane`
3. `job_retrieve` default cache mode vs `cache_mode=no_cache`.

## Results summary

### A) Common-name + store ambiguity

Observed response contract now includes store safety fields:

- `store_requested` populated from request
- `store_matched` empty when upstream payload lacks explicit store marker
- `store_match=false`
- `selection_required=true`

This is fail-closed behavior and prevents branch-confident output when store certainty is missing.

### B) No-cache retry path

Both default and `cache_mode=no_cache` calls returned successful results and preserved store guardrail metadata (`store_requested`, `selection_required`).

### C) ElevenLabs `/api` auth boundary

Direct unauthenticated call to `/api/elevenlabs/hubtiger/tool` returned `401 unauthorized voice ingress request` as expected (auth guard preserved).

## Pass/fail against readiness intent

- Ambiguity fail-closed behavior: **PASS**
- Store-scoping metadata exposed for caller decisions: **PASS**
- No-cache retry supported for read operations: **PASS**
- Secure auth boundary preserved on ElevenLabs path: **PASS**

## Remaining risk

Upstream `jobs/search` payload currently does not consistently expose store metadata (`store_matched` can be empty), so system correctly forces clarification in many cases. This is safe but may increase clarification prompts.

## Exact verify commands

```bash
python3.12 - <<'PY'
import json,urllib.request
base='http://localhost/api/hubtiger/test'
scenarios=[('southport','Sarah','Lee'),('brisbane','Sarah','Lee'),('burleigh','Sarah','Lee'),('southport','John','Smith'),('brisbane','John','Smith')]
for store,first,last in scenarios:
    payload={"operation":"job_search","payload":{"store":store,"first_name":first,"last_name":last}}
    req=urllib.request.Request(base,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'},method='POST')
    body=json.loads(urllib.request.urlopen(req,timeout=20).read().decode())
    case=body.get('data',{}).get('case_select',{})
    print(json.dumps({
        'store':store,
        'name':f'{first} {last}',
        'job_card_count':case.get('job_card_count'),
        'store_requested':case.get('store_requested'),
        'store_matched':case.get('store_matched'),
        'store_match':case.get('store_match'),
        'selection_required':case.get('selection_required')
    }))
PY
```

```bash
python3.12 - <<'PY'
import json,urllib.request
url='http://localhost/api/hubtiger/test'
for mode in (None,'no_cache'):
    payload={'operation':'job_retrieve','payload':{'store':'southport','job_card_no':'#35872'}}
    if mode:
        payload['payload']['cache_mode']=mode
    req=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'},method='POST')
    body=json.loads(urllib.request.urlopen(req,timeout=20).read().decode())
    print(json.dumps({
        'cache_mode':mode or 'default',
        'success':body.get('success'),
        'store_requested':body.get('data',{}).get('case_select',{}).get('store_requested'),
        'selection_required':body.get('data',{}).get('case_select',{}).get('selection_required')
    }))
PY
```
