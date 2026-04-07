# GhostDASH Human QA Checklist

## Intuition
- Can a first-time operator find Agents, Data Sources, Connections, Logs, and chat quickly?
- Do actions use clear verbs like Create, Save, Test, Sync, Refresh?

## No duplicated settings
- LLM/runtime settings editable in one place only
- guardrails/policy settings editable in one place only
- KB/retrieval settings editable in one place only
- tool permission settings editable in one place only

## Flow sanity
- create flow is obvious
- edit flow persists correctly
- confirmations are explicit
- loading does not freeze unrelated navigation

## Errors
- network or backend failures produce actionable messaging
- recovery path is obvious

## Responsive sanity
- no clipped controls
- no unusable overlays
- no unreadable text at narrow widths
