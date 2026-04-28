# Expose HubTiger Tools To ElevenLabs — Build Spec

## Objective

Expose Ride Electric HubTiger customer-service tools to ElevenLabs Agents as secure server tools.

ElevenLabs must not call HubTiger directly.

Correct architecture:

```text
ElevenLabs Agent server tool
→ GhostDash public webhook endpoint
→ GhostDash auth + tool policy
→ HubTiger tool adapter
→ public-safe result
→ ElevenLabs Agent
```

## Why this shape

ElevenLabs Agents support server tools/webhook tools that call external APIs. Tool descriptions and parameter schemas tell the agent when and how to call them. Authentication should be configured as headers/secrets in ElevenLabs or workspace auth, not exposed in prompts.

GhostDash must remain the policy boundary because it owns:

```text
HubTiger credentials
read_only/read_write gating
Magic Mike permissions
customer-safe result formatting
trace logging
retry/idempotency
secret redaction
```

## Do not do this

```text
ElevenLabs → HubTiger direct
ElevenLabs prompt contains HubTiger credentials
browser contains HubTiger credentials
Magic Mike gets raw HubTiger errors
write tools enabled during read-only testing
```

## Server tool endpoints

Expose these GhostDash endpoints:

```text
POST /api/elevenlabs/hubtiger/booking_availability
POST /api/elevenlabs/hubtiger/job_search
POST /api/elevenlabs/hubtiger/job_get
POST /api/elevenlabs/hubtiger/products_search
POST /api/elevenlabs/hubtiger/quote_preview
```

Read/write endpoints may exist but must be blocked unless explicitly enabled:

```text
POST /api/elevenlabs/hubtiger/booking_create
POST /api/elevenlabs/hubtiger/job_note_add
POST /api/elevenlabs/hubtiger/quote_add_line_item
POST /api/elevenlabs/hubtiger/quote_request_approval_sms
```

Current default:

```env
HUBTIGER_TOOL_ACCESS=read_only
```

## ElevenLabs authentication

Use a GhostDash-facing secret header:

```text
X-Ghost-Voice-Key: <ELEVENLABS_HUBTIGER_WEBHOOK_SECRET>
```

or:

```text
Authorization: Bearer <ELEVENLABS_HUBTIGER_WEBHOOK_SECRET>
```

The GhostDash endpoint must reject unauthenticated requests.

## Public-safe response contract

Every endpoint returns:

```json
{
  "success": true,
  "public_message": "I found available workshop slots.",
  "data": {},
  "error_code": null,
  "retryable": false
}
```

Never return raw HubTiger responses directly to ElevenLabs.

Never expose:

```text
HubTiger username
HubTiger password
HubTiger API code
JWT token
legacy token
Authorization header
stack trace
raw HTTP body
```

## Magic Mike prompt rule

Magic Mike may use HubTiger tools only for customer-service tasks:

```text
availability
booking flow
existing job lookup
job note capture
product lookup
quote preview
quote approval flow
```

Magic Mike must not claim success unless the tool returns `success=true`.

## Read-only testing

In read-only mode, ElevenLabs may call:

```text
booking_availability
job_search
job_get
products_search
quote_preview
```

In read-only mode, write endpoints return:

```json
{
  "success": false,
  "public_message": "I can check that for you, but booking or changes are not enabled yet.",
  "error_code": "hubtiger_read_only_mode",
  "retryable": false
}
```

## Cursor task

Install the files in `integrations/elevenlabs_hubtiger/` into the active GhostDash backend.

Wire the router into agent-ingress or the appropriate FastAPI service.

Do not duplicate the existing HubTiger adapter if one already exists. Reuse existing GhostDash HubTiger code where available and keep this facade as the ElevenLabs-facing policy boundary.
