---
name: ghostdash-project-builder
description: Guides whole-system GhostDash development with inspection, correct service boundaries, lean changes, and proof. Use when working on GhostDash, especially agent-ingress, workflow-runtime, GhostChat, Magic Mike, ElevenLabs voice, Hubtiger, Odoo, or Shopify tools, runtime profiles, guardrails, database schema, API routes, UI components, or Cursor rules. Enforces fit-for-purpose architecture, lean implementation, token efficiency, cleanup, proof, and whole-project reasoning instead of narrow static fixes.
---

# GhostDash Project Builder

Use this skill for GhostDash development work.

## Core mandate

Do not patch symptoms blindly. Understand GhostDash as a system, then make the smallest correct change at the right layer.

The correct result is:

- fit for the human task
- architecturally aligned
- lean
- testable
- token-efficient
- documented
- cleaned up
- proven

## Required workflow

### 1. Understand the request

Restate the actual requirement in practical terms.

Identify:

- user or operator
- task to be achieved
- affected GhostDash area
- likely service boundary
- existing implementation to inspect

Do not code before inspection.

### 2. Inspect before changing

Search for existing:

- routes
- services
- database tables
- migrations
- models
- config keys
- runtime profile entries
- tools
- UI components
- guardrails
- tests

If something already exists, extend or fix it unless replacement is clearly better.

### 3. Choose the correct layer

Use this map:

- public agent, chat, or voice ingress → agent-ingress
- workflow or tool execution → workflow-runtime
- admin, config, or control plane → control-api
- public UI or chat → GhostChat frontend
- persistent truth → Postgres
- volatile cache or session scratchpad → Redis
- retrieval → Qdrant or vector store
- public HTTPS routing → Caddy
- customer-facing agent behaviour → runtime profile and guardrails
- final response safety → output guard before stream or display

### 4. Avoid duplication

Before creating anything new, ask:

- does a similar service already exist?
- does a similar table already exist?
- does a similar component already exist?
- does a similar endpoint already exist?
- does a similar rule already exist?

Do not create parallel implementations.

### 5. Prefer deterministic code over LLM work

Use deterministic code for:

- validation
- formatting
- route selection
- output filtering
- schema enforcement
- calculations
- known workflow state machines
- token trimming
- guardrail pattern blocking

Use LLM only for:

- natural language understanding where rules are insufficient
- response generation
- summarisation where deterministic code is impractical
- ambiguous user intent

### 6. Build for human use

For UI or voice:

- reduce steps
- reduce confusion
- expose next action
- provide safe recovery
- avoid internal language
- optimise for task completion

If the UI technically works but a human would struggle, it is not done.

### 7. Clean up

After implementation:

- remove unused files
- remove obsolete code paths
- remove unused imports
- remove duplicate routes
- remove dead config
- avoid leaving temporary hacks
- document any intentional temporary compromise

### 8. Prove it

Return:

- summary
- changed files
- tests run
- proof output
- cleanup performed
- risks
- next recommended step

Never claim completion without proof.
