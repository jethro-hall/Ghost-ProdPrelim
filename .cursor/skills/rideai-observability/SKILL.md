---
name: rideai-observability
description: Enforce structured tracing, latency measurement, and downstream trace propagation across GhostDASH services. Use when adding endpoints, inter-service calls, tool calls, or telemetry behavior.
---

# RideAI Observability

Use this skill when changing endpoints, service-to-service calls, tool invocations, or telemetry.

## Required logging schema
- `trace_id`
- `span_id`
- `service`
- `route`
- `start_ts`
- `end_ts`
- `latency_ms`
- `status`
- `error`

## Required behavior
- accept trace context at ingress
- propagate trace context downstream
- measure latency at the caller boundary
- emit parseable structured JSON rather than ad-hoc console output

## Verification
- hit at least one health route and one feature route
- confirm trace identifiers and latency fields are present
- confirm async work preserves the originating trace where applicable
