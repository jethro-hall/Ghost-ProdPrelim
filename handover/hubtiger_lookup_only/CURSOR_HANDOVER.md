# Cursor Handover - Magic Mike HubTiger Lookup-Only Runtime

## Objective

Implement the first production-safe HubTiger flow for Magic Mike.

Current goal:

```text
Customer calls Ride Electric
-> Mike decides if the request is customer/workshop specific
-> Mike asks for mobile number or name only when needed
-> Mike calls one canonical HubTiger tool
-> Backend retrieves safe job/customer/message context
-> Mike tells the customer whether there is a message or update
-> Mike offers to put them through to the store
```

This is not a booking build yet. This is lookup-only, fast, accurate, and low-drift.

## Canonical endpoint

Expose one endpoint:

```text
POST /api/elevenlabs/hubtiger/tool
```

Health:

```text
GET /api/elevenlabs/hubtiger/health
```

## Required runtime path

```text
ElevenLabs Agent
-> GhostDash control-api or agent-ingress public API
-> /api/elevenlabs/hubtiger/tool
-> auth check
-> request normalization
-> function alias mapping
-> HubTiger MCP execute
-> response redaction and shaping
-> PublicToolResult
-> Magic Mike short customer-safe answer
```

## Files in this package

```text
backend_patch/hubtiger_elevenlabs_schemas.py
backend_patch/hubtiger_elevenlabs_tool.py
backend_patch/test_hubtiger_elevenlabs_tool.py
elevenlabs/hubtiger_lookup_job_tool.json
prompts/magic_mike_lookup_only_system_prompt.txt
handover/hubtiger_lookup_only/CURSOR_HANDOVER.md
```

## Where to mount

Mount the router in the FastAPI service that owns `/api/*`.

The architecture docs indicate `control-api` owns canonical `/api/*`; if current routing sends public `/api/*` to another service, mount there too or fix Caddy routing.

Preferred:

```python
from ghostdash_api.integrations.hubtiger_elevenlabs_tool import router as elevenlabs_hubtiger_router
app.include_router(elevenlabs_hubtiger_router)
```

Do not mount only in a service that Caddy does not route to.

## Environment

```env
ELEVENLABS_HUBTIGER_WEBHOOK_SECRET=long_random_secret
HUBTIGER_TOOL_ACCESS=read_only
HUBTIGER_MCP_URL=http://hubtiger-mcp:8000
HUBTIGER_READ_TIMEOUT_MS=2500
HUBTIGER_MAX_ROWS=5
HUBTIGER_MAX_FIELD_CHARS=600
HUBTIGER_MAX_PAYLOAD_CHARS=12000
```

Keep `HUBTIGER_TOOL_ACCESS=read_only` until explicitly approved.

## ElevenLabs workflow

Use three nodes only:

```text
Start
-> Magic Mike Intake
   -> HubTiger Lookup
   -> General Ride Electric Support
```

Only the HubTiger Lookup node gets a tool.

Tool:

```text
hubtiger_lookup_job
```

Do not enable booking, quote mutation, job note add, or product tools in this lookup-only phase.

## Tool activation policy

Call HubTiger only when the customer:

```text
asks about their own bike/scooter
says their bike/scooter is in the workshop
asks about pickup, drop-off, repair status, job status, quote status, or service status
asks whether there is a message for them
says they are returning a call from Ride Electric, mechanic, workshop, or reception
```

Do not call HubTiger for:

```text
greetings
general product questions
general warranty process
store/location questions
general Ride Electric questions
road rules/legal questions
```

## Expected customer flow

Returning call:

```text
Customer: I missed a call from you guys.
Mike: Can I grab your mobile number so I can check what the team called about?
Tool: hubtiger_lookup_job
Mike: I found a note from the team. [safe summary]. Would you like me to put you through to the store?
```

No message:

```text
Mike: I can see your record, but I do not have a clear message showing for you. Would you like me to put you through to the store?
```

No record:

```text
Mike: I could not confidently find that record. Would you like me to put you through to the store so they can check it directly?
```

## Acceptance checks

1. `/api/elevenlabs/hubtiger/health` returns non-404.
2. Missing or wrong key returns 401.
3. Missing configured secret returns 503.
4. Valid key returns health with `auth_configured=true`.
5. `lookup_job` with phone reaches MCP or safe unavailable result.
6. Raw MCP/proxy/HubTiger errors are never returned to ElevenLabs.
7. Greeting does not call tool.
8. Returning call asks for mobile before lookup.
9. Tool response is customer-safe.
10. Mutation functions are blocked in read-only mode.

## Smoke tests

```bash
curl -i https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/health
```

Expected without key:

```text
401 or 503, not 404
```

With key:

```bash
curl -i \
  -H "X-Ghost-Voice-Key: $ELEVENLABS_HUBTIGER_WEBHOOK_SECRET" \
  https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/health
```

Lookup:

```bash
curl -sS -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/tool" \
  -H "Content-Type: application/json" \
  -H "X-Ghost-Voice-Key: $ELEVENLABS_HUBTIGER_WEBHOOK_SECRET" \
  -d '{"function":"lookup_job","customer":{"phone":"0435185134"},"payload":{}}'
```

## Do not ship until

```text
route is mounted
pytest passes
curl health works externally
lookup returns safe shaped result
ElevenLabs tool validates
one test call proves no internal leakage
```
