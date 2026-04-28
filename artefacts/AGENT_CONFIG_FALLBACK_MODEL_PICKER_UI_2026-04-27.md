# Agent Config Fallback Model Picker UI

Date: 2026-04-27

## Decision

Agent Config multi-LLM fallback model selection now reuses the existing GhostDASH model picker source from `ui/src/lib/modelIdMemory.ts`.

This keeps provider creation and credential editing in the canonical Connections/RightPanel surface, while giving the agent fallback model override the same operator-friendly quick-pick plus manual-entry workflow used elsewhere.

## Scope

- UI-only change in `ui/src/pages/AgentConfigPage.tsx`.
- No backend API, schema, Docker, Caddy, or runtime setting ownership changes.
- Existing persisted field remains `llm_orchestration.fallback_model_id`.

## Operator Flow

1. Open Agent Config.
2. Enable optional multi-LLM orchestration.
3. Choose a fallback connection.
4. Pick a fallback model from the quick-pick dropdown, or type a fallback model id manually.
5. Save the agent only when the operator wants to persist the selected fallback model.

## Verification

- `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile && pnpm run lint && pnpm run build"` passed.
- Browser QA passed on isolated temporary UI server at `http://localhost:5174/agent`.
- Human flow confirmed:
  - `Fallback connection` remained visible.
  - `Fallback provider id (not API key)` remained visible.
  - `Quick pick fallback model id` was visible.
  - `openai/llama31-8b` was selectable.
  - Manual `Or type a fallback model id` accepted `openai/llama31-8b`.
  - No save was performed during QA.

## Notes

The running project already had a dirty working tree. This change was kept to the Agent Config fallback model UI and did not add a second provider editor inside Agent Config.
