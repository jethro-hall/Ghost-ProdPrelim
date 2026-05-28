# Voice LLM Ingress Architecture

Date: 2026-04-27

## Purpose

GhostStack exposes a low-latency OpenAI-compatible voice LLM endpoint for ElevenLabs while keeping GhostStack as the source of truth for agent runtime profiles, provider routing, guardrails, audit state, and tool policy.

## Service Ownership

- `caddy`: public HTTPS edge. Existing `/agent/*` routing sends voice traffic to `agent-ingress`.
- `agent-ingress`: owns `POST /agent/v1/chat/completions`, voice auth, session mapping, idempotency, inline guards, streaming adapter, trace/audit persistence, and provider streaming.
- `workflow-runtime`: remains the execution boundary for governed retrieval/tool workflows. Live voice mode does not bypass it.
- `postgres`: stores voice turn state, request metadata, response/audit details, conversations, and messages.
- `qdrant`: used only when existing GhostStack runtime logic supplies retrieval context.
- `redis`: intentionally not introduced. Postgres remains the system of record until measured latency proves a volatile lock/rate-limit cache is needed.

## Request Flow

1. Caller speaks to the Twilio-routed ElevenLabs Agent.
2. ElevenLabs calls `POST /agent/v1/chat/completions` through Caddy.
3. `agent-ingress` validates the optional shared secret when configured.
4. `agent-ingress` maps provider session metadata to a `voice_turns` row.
5. Duplicate completed turns replay the stored answer; in-progress duplicates return `409`.
6. Inline pre-guard blocks caller model/tool overrides and prompt or secret extraction attempts.
7. Runtime profile model/provider settings resolve the downstream provider call.
8. Provider deltas pass through a chunk-buffered streaming guard before reaching ElevenLabs.
9. Final status, answer, usage, latency, and audit metadata are persisted.
10. Async audit logging records completion context after streaming.

## Guard Budget

- Pre-guard target: under 150 ms.
- Routing/cache target: under 250 ms.
- First spoken content target: under 1500 ms for direct-model turns.
- Default voice output cap: 160 tokens.
- Streaming guard holdback: 32 characters.

## State Lifecycle

`voice_turns.status` uses:

- `received`: request accepted and durable before model/tool work.
- `streaming`: provider stream has started.
- `completed`: answer finished and persisted.
- `blocked`: pre-guard or streaming guard stopped the response.
- `timeout`: provider/tool timeout classified during streaming.
- `client_disconnected`: downstream stream closed before completion.
- `failed`: non-timeout execution failure.

## Tool And Cache Policy

Live voice cache is disabled in the first implementation except for future explicitly safe static FAQs. Tool execution is not caller-controlled: request `tools` and `tool_choice` are blocked at pre-guard. Mutating or slow operations should become confirmation or async workflows rather than spoken commitments.

## Rollout

1. Configure `APP_VOICE_INGRESS_SECRET` before exposing the endpoint to ElevenLabs.
2. Configure ElevenLabs Custom LLM URL to `https://ghoststack.rideai.com.au/agent/v1/chat/completions`.
3. Send `X-Ghost-Voice-Key` or `Authorization: Bearer` with the configured secret.
4. Include metadata keys where available: `agent_id`, `twilio_call_sid`, `elevenlabs_conversation_id`, and `turn_id`.
5. Run curl streaming smoke test before routing real Twilio traffic.
6. Run human call QA against greeting, interruption, guard block, timeout fallback, and uncertainty handling.

## Rollback

Disable the ElevenLabs Custom LLM endpoint or remove the shared secret from the ElevenLabs side. Existing Ghost ChatUI traffic remains on `/agent/chat/stream` and is not affected by the voice adapter.

## Human QA Checklist

- Caller greeting feels immediate and natural.
- Interrupting mid-answer does not create duplicate GhostStack turns.
- Asking for secrets or system prompts returns a safe refusal.
- Caller-supplied model/tool override is rejected.
- Provider timeout returns a short human-safe fallback.
- Logs contain one `trace_id` for the voice turn, provider call, guard state, and final audit event.
