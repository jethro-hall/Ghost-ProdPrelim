## Chat Latency And OpenWebUI Plan Artifact

### Status

This plan is **not fully completed**.

Current status:

- Architecture and performance review: **completed**
- OpenWebUI endpoint review: **completed**
- Latency/resource fixes: **partially implemented**
- Full end-to-end latency resolution for large strategic requests: **not completed**
- OpenWebUI compatibility shim: **not implemented yet**

### Why this artifact exists

The plan previously lived only in chat/transcript history. This document makes it explicit in the repo so implementation status can be tracked without relying on memory.

### Completed so far

These findings and partial fixes were completed before this artifact was written:

1. Query-routing bug investigation and fix
- Broad strategic prompts were incorrectly falling into spreadsheet structured lookup.
- Root cause: loose substring matching, especially around `id`.
- Outcome: strategy/FY26/position-paper style prompts now route away from the row-lookup path.

2. Structured planner cost reduction
- The planner was still scanning workbook rows even for semantic strategy prompts.
- Outcome: structured candidate search was skipped for semantic-only strategy requests.

3. Timeout hardening in chat path
- Query-plan timeout behavior was improved.
- Non-stream answer path was hardened so blank/failed generations do not produce empty bodies as easily.

4. Performance review completed
- The largest wall-clock cost was identified as remote model generation plus oversized prompts.
- Live evidence showed the current stack is not primarily CPU-bound on-box for chat.
- GPU is currently helping Qdrant, not chat inference.

5. OpenWebUI API review completed
- Current public chat endpoints were documented.
- It was confirmed that the current `/agent/*` API is custom, not OpenAI-compatible.

### Current unresolved problem

The exact large strategic request pattern can still be too slow for a comfortable synchronous round trip:

- approved web fetches
- large retrieved evidence
- long-form strategic instructions
- large output budget

That means:

- the old obviously wrong `Id is ...` behavior is fixed
- the earlier planner-timeout / 500 path is fixed
- but the overall request can still run too long because final answer generation is too heavy

So the key remaining issue is:

`correct routing achieved, but long-form generation path still needs architectural latency reduction`

### Adopted plan

The agreed next plan is:

1. Force long strategic / position-paper requests onto the streaming path only
- avoid using the blocking `/agent/chat` path for very heavy responses
- stop treating giant strategic outputs like normal chat answers

2. Split long strategy generation into staged sections
- regulatory impact
- financial exposure
- FY26 options
- executive recommendation

3. Cap and prioritize retrieved evidence before final generation
- reduce prompt size
- reduce noisy workbook-row dominance
- improve citation quality for strategic answers

4. Add a dedicated strategy / position-paper mode
- separate these requests from normal Q&A behavior
- use a different planning/generation path for long-form work

5. Add an OpenWebUI compatibility shim
- `GET /v1/models`
- `POST /v1/chat/completions`
- keep native `/agent/*` routes unchanged

6. Longer-term architecture option
- if true hardware leverage is wanted for chat inference, move generation local
- current GPU usage mainly helps Qdrant, not provider-hosted LLM generation

### Architecture review summary

The review concluded:

- end-to-end chat latency is dominated by remote provider generation and prompt volume
- current on-box CPU/GPU usage is not the primary reason for the long chat path
- local hardware is not currently the main chat bottleneck because inference is still provider-side
- the current chat API is custom and needs a compatibility layer for OpenWebUI

### Exact status by work item

1. Performance review
- Status: **completed**

2. API/endpoint review for OpenWebUI
- Status: **completed**

3. Misrouting fix for strategic prompts
- Status: **completed**

4. Planner optimization for semantic strategy prompts
- Status: **completed**

5. Full latency fix for long strategic requests
- Status: **not completed**

6. OpenWebUI compatibility implementation
- Status: **not started**

### Acceptance criteria

This artifact is considered correct if:

- the plan no longer exists only in transcript history
- completion state vs non-completion state is explicit
- completed vs pending items are separated clearly
- next implementation steps are concrete enough to execute

### Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag
rg -n "classify_query_mode|find_structured_candidates|build_query_plan" backend/src/ghostdash_api/workflows.py
rg -n "agent/chat|agent/chat/stream|v1/chat/completions|v1/models" backend/src/ghostdash_api ui/src
```

```bash
cd /var/llamaindex/ghoststack-rag
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker stats --no-stream ghoststack-rag-agent-ingress-1 ghoststack-rag-workflow-runtime-1 ghoststack-rag-control-api-1 ghoststack-rag-qdrant-1
nvidia-smi
```
