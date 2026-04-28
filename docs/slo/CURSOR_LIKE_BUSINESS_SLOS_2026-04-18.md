# Cursor-like Business SLO Baseline

## SLO Targets

- Workflow run API availability: `99.9%` monthly.
- Run event append latency (`P95`): `< 75ms`.
- MAS run list/read latency (`P95`): `< 450ms`.
- Tool governance decision latency (`P95`): `< 150ms` before tool call dispatch.
- End-to-end multi-agent completion (`P95`): `< 45s` for 3-agent consult runs.

## Error Budgets

- Workflow API: `43m 49s` downtime/month.
- Tool policy decision failures: `< 0.1%` of tool invocations.
- Run replay mismatches: `0` tolerated in release verification.

## Dashboard Panels (Implementation Spec)

1. `workflow_runs_total{status}` and `workflow_runs_active`
2. `workflow_event_append_duration_ms` (P50/P95/P99)
3. `tool_policy_decisions_total{risk_class,decision}`
4. `tool_execution_audits_total{status}`
5. `workflow_run_replay_failures_total`
6. `mas_run_completion_duration_ms` histogram

## Load Verification

Use:

```bash
cd /var/llamaindex/ghoststack-rag && python scripts/load/workflow_run_smoke_load.py --base-url http://localhost:80 --concurrency 8 --iterations 5
```

Pass gate:

- Success rate >= `99%`
- P95 <= `450ms` for run list endpoint

