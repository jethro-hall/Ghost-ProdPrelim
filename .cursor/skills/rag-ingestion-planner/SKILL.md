---
name: rag-ingestion-planner
description: Plan GhostDASH LlamaIndex ingestion, metadata schema, chunking, vector storage, and GraphRAG integration. Use when the user asks to ingest data, tune retrieval, add GraphRAG, or choose embedding/vector settings.
---

# Skill: RAG Ingestion Planner

## Goal

Turn vague RAG ingestion requests into a repo-grounded plan before implementation.

## Gather first

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/OPERATIONS.md`
- `docker-compose.yml`
- the closest matching template under `../llama-agent-templates/`

## Repo defaults

- Primary relational store: `postgres`
- Primary vector store: `qdrant`
- Runtime services: `control-api`, `agent-ingress`, `workflow-runtime`
- Default model env vars live in `docker-compose.yml`

Do not present other vector or graph stores as already deployed unless the repo truly wires them in.

## Mandatory workflow

1. Start with a short repo reality check.
2. If ingestion is requested, write a **Data Ingestion Plan (DIP)** before code.
3. Refuse to skip schema, parser, and metadata design.
4. If the request risks duplicated storage or weak provenance, say so and propose a leaner design.

## DIP template

Use this exact section structure:

```markdown
## Data Ingestion Plan

### DataSource
- Source type
- Data volume
- Expected update cadence

### Schema
- Required metadata keys
- Entity or document types
- Provenance fields

### Parsing
- Selected NodeParser
- chunk_size
- chunk_overlap
- cleaning rules
- why this parser fits the source

### Embeddings
- embedding model
- distance metric
- expected retrieval behavior

### Storage
- vector store
- relational or graph store
- index or collection settings
- why this layout fits GhostDASH
```

## Required metadata baseline

Unless the task justifies more, include:

- `file_path`
- `ingestion_date`
- `corpus`
- `entity_type`
- `source_id`
- `content_hash`

## Implementation rules

- Prefer `IngestionPipeline`
- Prefer explicit `NodeParser` configuration over raw `Document` usage
- Clean text before embedding:
  - normalize whitespace
  - strip HTML or markup noise
  - preserve traceable provenance
- LlamaIndex code must include:
  - type hints
  - docstrings
  - short comments for parameter choices such as `similarity_top_k=5`

## GraphRAG extension

If the task includes GraphRAG:

1. Define entity types before ingestion.
2. Define relation types before ingestion.
3. State the graph store choice explicitly.
4. Explain how graph traversal is blended with vector retrieval.
5. If no graph store exists in repo reality, present GraphRAG as a staged addition rather than pretending it is already live.

## Delivery requirements

Every coding answer must include:

- `#### Ingestion Pipeline`
- `#### Query Engine Setup` when retrieval behavior changes
- `#### Integration & Configuration Documentation`

The documentation section must cover:

- required Docker images or services
- required `.env` variables
- why the structure is fit for purpose

## Verification

End with:

- acceptance criteria
- exact verify commands
- a human retest request when behavior affects operators or workflows
