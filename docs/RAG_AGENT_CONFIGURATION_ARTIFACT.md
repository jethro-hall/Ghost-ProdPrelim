# RAG Agent Configuration Artifact

## Scope

This artifact records the Cursor-side configuration added so GhostDASH can consistently apply a strict RAG and GraphRAG data-architecture workflow without relying on ad hoc prompts.

## Changes Applied

- Added `.cursor/rules/50-rag-data-architect.mdc` for automatic RAG guardrails on backend, docs, and stack work.
- Added `.cursor/agents/rag-data-architect.md` for explicit "act as the RAG architect" invocation.
- Added `.cursor/skills/rag-ingestion-planner/SKILL.md` for the repeatable data-ingestion-planning workflow.
- Updated `AGENTS.md` so the repo-level operating rules reference the new rule, agent, and skill.
- Corrected stale `AGENTS.md` repo reality so it matches the current compose-backed `postgres` + `qdrant` stack and current service names.

## Why This Structure

- The rule keeps the core data-quality constraints automatic when relevant files are in play.
- The agent gives you an explicit specialist persona for RAG architecture requests without forcing that verbosity onto unrelated tasks.
- The skill captures the repeatable procedure for turning vague ingestion asks into a concrete Data Ingestion Plan.
- Updating `AGENTS.md` makes the new behavior discoverable instead of leaving it as isolated prompt debt.

## Repo Reality Captured

- Running services observed on this host: `ghoststack-rag-caddy-1`, `ghoststack-rag-control-api-1`, `ghoststack-rag-agent-ingress-1`, `ghoststack-rag-workflow-runtime-1`, `ghoststack-rag-postgres-1`, `ghoststack-rag-qdrant-1`, `ghoststack-rag-ui-1`
- Active data stores in repo reality: `postgres` for relational state and `qdrant` for vector retrieval
- Current model defaults come from `docker-compose.yml`, including `OPENAI_MODEL` and `OPENAI_EMBEDDING_MODEL`
- No graph database is currently wired in `docker-compose.yml`, so GraphRAG is documented as an explicit staged addition rather than an invented current capability

## Acceptance Criteria

- The repo contains one automatic rule, one explicit agent, and one procedural skill for RAG work.
- The new artifacts are grounded in current GhostDASH service names and storage choices.
- The rule enforces a Data Ingestion Plan before ingestion code.
- The agent requires schema, parser, metadata, and storage choices before implementation guidance.
- The skill provides a reusable DIP template plus documentation and verification expectations.
- `AGENTS.md` references the new RAG guidance so it is discoverable in normal repo use.

## Verification Performed

- Read the existing repo guidance in `AGENTS.md`, `.cursor/rules/`, `.cursor/agents/`, and `.cursor/skills/` to match established structure.
- Read `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/INGESTION_HARDENING_ARTIFACT.md`, and `docker-compose.yml` to anchor the new artifacts to real stack boundaries and services.
- Checked the live Docker container list to confirm the current service names instead of relying on invented names.

## Residual Risk

- Cursor-side rules and agents are repo configuration, not runtime code; they improve planning quality but do not by themselves add GraphRAG infrastructure or ingestion code paths.
- Agent auto-discovery and persona usage still require real-world prompting in the IDE, so final verification includes a human test step.

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
rg -n "rag-data-architect|rag-ingestion-planner|Data Ingestion Plan" AGENTS.md .cursor docs/RAG_AGENT_CONFIGURATION_ARTIFACT.md
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-workflow-runtime-1
```

## Human Retest Request

Please open the `ghoststack-rag` repo in Cursor and try these prompts:

- "Use `rag-data-architect` to design a PDF ingestion pipeline for GhostDASH."
- "Plan GraphRAG for GhostDASH and start with a Data Ingestion Plan."
- "Add RAG ingestion for markdown files and include integration/config documentation."

Confirm that the response:

- starts with repo reality instead of invented services
- produces a DIP before code
- specifies parser, metadata, embeddings, and storage choices
- includes acceptance criteria and exact verify commands
