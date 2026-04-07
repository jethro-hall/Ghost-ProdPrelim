---
name: rideai-single-source-of-truth
description: Enforce one authoritative store and one canonical API for GhostDASH runtime settings such as LLM, guardrails, KnowledgeBase binding, retrieval policy, and tool policy. Use when touching schema, APIs, or settings UIs.
---

# Single Source Of Truth

Use this skill when adding or changing settings, schemas, APIs, or config UIs.

## Core rule
A runtime setting must have:
- one authoritative persistence location
- one canonical API contract
- one editable UI surface

## Required review
Before adding a setting, answer:
1. Who owns it?
2. Where is it persisted?
3. Which API returns it?
4. Where is it edited?
5. How do all other places read it without copying it?

## Anti-patterns
- duplicate setting columns across tables
- syncing the same value between multiple stores
- editable copies of the same setting in multiple UI pages
- mixing identity fields and runtime behavior into scattered entities without a clear owner

## Output expectations
- identify the canonical owner
- identify the canonical API
- identify the canonical UI editor
- provide the migration path if duplicates already exist
