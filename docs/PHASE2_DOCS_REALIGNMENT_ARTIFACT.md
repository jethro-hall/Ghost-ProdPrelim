# Phase 2 Docs Realignment Artifact

## Goal

Realign the roadmap and architecture documents so they describe the actual shipped LlamaIndex-native stack, do not reintroduce Milestone 1 runtime-setting duplication, and make the next recommended phases explicit.

## Problem found

The repo documentation had drifted in a way that could cause duplicated work:

1. `README.md` still described `control-api` and `postgres` in Milestone 0/Phase 1 terms and did not fully reflect runtime profiles, conversations/cache state, or vector aggregate APIs.
2. `docs/ARCHITECTURE.md` still spoke about `runtime defaults` as if that were the main ownership model instead of the now-shipped `runtime_profiles` system of record.
3. `docs/ARCHITECTURE_V2.md` still listed "Persisted provider/runtime defaults" as a future Phase 2 task even though Milestone 1 already completed that work in a stronger single-source-of-truth form.

That doc drift was dangerous because it pointed future work back toward a solved problem and made it easier to accidentally recreate duplicate settings ownership.

## Changes applied

Updated `README.md`:

- clarified `control-api` as the operator-facing control plane for runtime-profile compatibility views, documents, vector stats, and ingest runs
- clarified `postgres` as the system of record for runtime profiles, provider connections, conversations, and cache state
- updated the core API surface to include:
  - `GET /api/runtime/defaults` as a compatibility view
  - `POST /api/runtime/defaults` as the compatibility update contract
  - `GET /api/agents`
  - `POST /api/agents`
  - `GET /api/vector-stats`
- expanded the docs list to point at the current architecture artifacts

Updated `docs/ARCHITECTURE.md`:

- replaced the old `runtime defaults` wording with runtime-profile-backed ownership
- documented that `agent-ingress` resolves runtime profiles, memory/cache behavior, and approved-web allowlist usage
- documented that `workflow-runtime` now performs structure-aware chunking for headed text
- documented Postgres ownership for runtime profiles, agent profiles, conversations, and cached responses
- clarified the document path to mention structure-aware chunk metadata for document-oriented sources

Rewrote `docs/ARCHITECTURE_V2.md` as a status-aware roadmap:

- marked Phase 1 capability surfacing as shipped
- marked Milestone 1 runtime-profile ownership as shipped
- marked the current Phase 2 retrieval/operator-truth slices as shipped:
  - structure-aware chunking
  - section-aware citation metadata
  - `GET /api/vector-stats`
  - approved-web allowlist support
- replaced the stale future-work section with the next recommended phases:
  - server-side tool execution boundary
  - stable per-agent runtime endpoints
  - richer operator observability/citation inspection

## Why this is fit for purpose

- It restores a truthful architecture record.
- It prevents the roadmap from sending future work back into already-solved runtime-setting ownership.
- It keeps the LlamaIndex-native story grounded in the actual stack:
  - LlamaIndex workflows for ingestion/query planning
  - Postgres as the operator system of record
  - Qdrant as a derived vector store
  - runtime profiles as the single owner of runtime behavior

## Verification performed

Repo/runtime evidence checked:

- `git status --short`
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
- attempted log checks using the old example names from prior instructions, which failed because the real running containers are named:
  - `ghoststack-rag-caddy-1`
  - `ghoststack-rag-control-api-1`

That mismatch was itself useful verification: the docs/release process must reference actual repo/runtime names rather than stale shorthand.

Content verification:

- reviewed the README diff for service descriptions, API surface, and docs index
- reviewed `docs/ARCHITECTURE.md` diff for current ownership and runtime behavior
- reviewed the full rewrite of `docs/ARCHITECTURE_V2.md` to confirm Milestone 1 is represented as complete rather than future work

## Issues found and repaired

Issue:

- verification instructions from older guidance referred to container names that do not exist in the current running stack

Repair:

- switched verification to the actual running container names discovered from `docker ps`
- preserved that fact in this artifact so future checks stay drift-intolerant

## Acceptance criteria

- docs no longer describe runtime-profile ownership as future Phase 2 work: met
- architecture docs now reflect the shipped retrieval/operator-truth features: met
- README now references the current control-plane/API/documentation surfaces: met
- next phases now focus on unsolved boundaries rather than duplicating Milestone 1: met

## Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag
git diff -- README.md docs/ARCHITECTURE.md docs/ARCHITECTURE_V2.md docs/PHASE2_DOCS_REALIGNMENT_ARTIFACT.md
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker logs --tail=120 ghoststack-rag-caddy-1
docker logs --tail=120 ghoststack-rag-control-api-1
```

## Human retest request

Please review these docs as an operator/architect sanity pass:

1. Open `README.md` and confirm the service descriptions and API list match the product you expect to operate.
2. Open `docs/ARCHITECTURE.md` and confirm ownership is clear for `control-api`, `agent-ingress`, `workflow-runtime`, and Postgres.
3. Open `docs/ARCHITECTURE_V2.md` and confirm it now reads as a truthful roadmap from the current stack, not a plan that recreates Milestone 1.
