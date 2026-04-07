# Architecture

## Overview

```mermaid
flowchart LR
  browser[OperatorBrowser] --> caddy[CaddyEdge]
  caddy --> ui[GhostDashUI]
  caddy --> controlApi[ControlAPI]
  caddy --> agentIngress[AgentIngress]
  controlApi --> postgres[Postgres]
  controlApi --> workflowRuntime[WorkflowRuntime]
  agentIngress --> workflowRuntime
  workflowRuntime --> postgres
  workflowRuntime --> qdrant[Qdrant]
  workflowRuntime --> openai[OpenAIProvider]
  workflowRuntime --> llamaParse[LlamaParse]
```

## Service Responsibilities

### `control-api`

Thin operator-facing control plane for:

- uploads
- connection management
- runtime-profile-backed operator defaults through the `/api/runtime/defaults` compatibility view
- agent configuration and conversation inventory
- ingestion run state
- document inventory and structure stats
- authoritative vector aggregate stats
- capability reporting

### `agent-ingress`

Dedicated runtime query boundary for `/agent/*`.

Responsibilities:

- accept chat and streaming chat requests
- resolve the selected agent and runtime profile
- apply conversation memory and response cache behavior
- optionally inject approved-web context from the runtime profile allowlist
- fetch workflow-generated query plans
- return exact structured answers or LLM-grounded answers
- keep all runtime query traffic off `/api/*`

### `workflow-runtime`

LlamaIndex-native workflow service.

Responsibilities:

- run ingestion workflows without a polling loop
- build relational workbook structure for XLSX
- create retrieval artifacts and provenance
- use structure-aware chunking for headed text and markdown-like sources
- index retrieval artifacts into `Qdrant`
- build structured, semantic, and blended query plans

### `postgres`

System of record for:

- documents and versions
- ingestion runs
- provider connections
- runtime profiles
- agent profiles, conversations, and cached responses
- workbook sheets, tables, and rows
- retrieval artifact metadata

### `qdrant`

Vector retrieval store for derived retrieval artifacts.

### `ui`

GhostDASH operator console.

### `caddy`

HTTPS edge and route boundary:

- `/api/*` → `control-api`
- `/agent/*` → `agent-ingress`
- `/` → `ui`

## Ingestion Model

```mermaid
flowchart LR
  upload[UploadedArtifact] --> controlApi[ControlAPI]
  controlApi --> workflowRuntime[WorkflowRuntime]
  workflowRuntime --> decision[LaneAndKindRouter]
  decision --> spreadsheet[TableFirstSpreadsheetPath]
  decision --> document[DocumentParsePath]
  spreadsheet --> postgres[Postgres]
  spreadsheet --> retrieval[RetrievalArtifacts]
  document --> retrieval
  retrieval --> qdrant[Qdrant]
```

### Spreadsheet path

XLSX/XLSM is treated as structured data first:

- immutable source metadata is persisted
- workbook, sheet, table, and row records are stored in `Postgres`
- row and sheet summaries are generated as retrieval artifacts

### Document path

PDF, DOCX, TXT, HTML, Markdown, and similar files stay document-oriented:

- local or cloud parse lane
- structure-aware chunked retrieval artifacts with provenance and section metadata where available
- vector indexing in `Qdrant`

## Query Model

```mermaid
flowchart LR
  user[UserPrompt] --> agentIngress[AgentIngress]
  agentIngress --> workflowRuntime[WorkflowRuntime]
  workflowRuntime --> router[QueryModeRouter]
  router --> structured[StructuredLookup]
  router --> semantic[SemanticRetrieval]
  router --> blended[BlendedPlan]
  structured --> postgres[Postgres]
  semantic --> qdrant[Qdrant]
  blended --> postgres
  blended --> qdrant
  workflowRuntime --> answer[GroundedAnswer]
  answer --> agentIngress
```

Additional runtime behavior resolved at `agent-ingress`:

- conversation memory and per-agent cache lookup
- approved-web allowlist fetches when explicitly requested or when the user names an allowlisted domain
- runtime-profile-owned model, guardrail, retrieval, and tool policy settings

## Verification Goals

- stack starts cleanly in Docker with `postgres`, `control-api`, `agent-ingress`, `workflow-runtime`, `qdrant`, `ui`, and `caddy`
- `/api/*` and `/agent/*` are distinct runtime boundaries
- XLSX ingest persists relational workbook structure
- exact spreadsheet lookups can be answered without reparsing files
- semantic and blended retrieval still work through `Qdrant`
