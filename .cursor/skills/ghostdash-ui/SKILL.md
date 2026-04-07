---
name: ghostdash-ui
description: Build or refine GhostDASH glass UI slices in ui/ and wire them only to /api/*.
---

# Skill: GhostDASH UI Slice

## When to use

Use this when implementing or refining the operator console in `ui/`.

## Gather first

- `docs/GHOSTDASH_UI_ARCHITECTURE.md`
- `ui/src/index.css`
- `ui/src/components/AppLayout.tsx`
- `ui/src/pages/`

## Required components

Maintain or extend:

1. `Sidebar`
2. `Header`
3. `RightPanel`
4. `GhostChat`
5. `FullScreenLoader`

## Wiring rules

- UI calls only `/api/*`.
- Use `ui/src/api.ts`.
- No direct browser calls to OpenAI, Qdrant, or `llama-stack`.

## Build checklist

- Preserve glass primitives and the `GhostDASH` color palette.
- Keep SPA routing.
- Validate mobile overlay behavior for panels/chat.
- If `pnpm` is unavailable on the host, validate with:
  `docker run --rm -v "/var/llamaindex/ghoststack-rag/ui:/workspace" -w /workspace node:22-bookworm-slim bash -lc "corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile || pnpm install && pnpm run lint && pnpm run build"`
