# Required Structured Log Fields

Every inter-service or tool call log must include:

- `trace_id`
- `span_id`
- `service`
- `route`
- `start_ts`
- `end_ts`
- `latency_ms`
- `status`
- `error`

## Notes
- keep logs single-line JSON
- use `null` rather than omitting fields
- prefer one structured summary event per meaningful boundary call
