# PROD ChatUI Latency + Duplicate Refresh Fix (2026-04-28)

## Requirement summary
- Improve `prod_chatui` responsiveness after crash fix, focusing on first-reply perception and duplicate refresh traffic.

## Root cause
1. Frontend effect in `useGhostChat` reloaded conversations whenever `isGenerating` flipped false, causing duplicate post-turn API fetches.
2. Stream start callback also fetched uploads immediately, adding extra network traffic that did not improve first-turn UX.
3. UI remained in generating state until post-turn refreshes completed, extending perceived latency.

## Correct layer
- `ghost-chatui` frontend state orchestration (`/var/Ghost-chatUI/src/lib/state/useGhostChat.ts`), not control-api or Caddy.

## Existing component reused
- Existing `useGhostChat` stream lifecycle (`onStart`, `onDone`, hydration effect) was corrected in place.

## Proposed/implemented change
1. Removed `isGenerating` dependency from the conversation reload effect to prevent automatic duplicate reload after every stream completion.
2. Removed `refreshUploads` call from stream `onStart` (no value for initial response path).
3. Moved `setIsGenerating(false)` / abort release earlier in `onDone` so the composer unlocks immediately.
4. Kept post-turn conversation/upload sync in a background async task.
5. Skipped expensive `fetchMessages` re-hydration on `prod_chatui` after stream completion (preserve stream-rendered assistant content, reduce one round trip).

## Files changed
- `/var/Ghost-chatUI/src/lib/state/useGhostChat.ts`

## Parity sweep status
- **Parity status:** `/var/Ghost-chatUI only`
- Sweep check: `ghoststack-rag/ui/src` has no corresponding `useGhostChat` or `/agent/chat/stream` production-chat surface implementation to patch.

## Tests and proof
1. Frontend build:
   - `npm run build` (in `/var/Ghost-chatUI`) -> success.
2. Frontend tests:
   - `npm run test` -> 22 files passed, 35 tests passed.
3. Runtime:
   - `docker compose up -d --build ghost-chatui` -> success.
   - `docker compose ps` -> `ghost-chatui`, `agent-ingress`, `control-api`, `caddy` all up/healthy.
4. Human browser verification (`https://ghoststack.rideai.com.au/prod_chatui/`):
   - New chat + send prompt works.
   - Assistant response renders.
5. Network verification after one prompt:
   - Post-turn refresh reduced to single `GET conversations` + single `GET uploads`.
   - Duplicate `GET messages` and duplicate conversations/uploads calls no longer observed.

## Latency observation snapshot
- Recent ingress traces on prompt:
  - `/agent/chat/stream` pre-model phase ~`425ms`
  - upstream model stream ~`2176ms`
- Prior observed pre-model phase was higher (~`678ms`), now reduced.

## Cleanup performed
- No new components or duplicate paths created.
- Existing refresh logic streamlined in-place.

## Remaining risk / shortcomings
1. Model stream time (~2s+) remains the dominant first-reply latency factor.
2. `npm run lint` currently fails in this repo due pre-existing TypeScript issue in `src/vite-env.d.ts` (unrelated to this change).

## Acceptance criteria
- `prod_chatui` sends and receives responses without duplicate post-turn refresh bursts.
- UI input unlocks promptly after stream completes.
- Stack remains healthy.

## Exact verify commands
- `docker compose ps`
- `docker logs --since=90s ghoststack-rag-agent-ingress-1`
- `docker logs --tail=120 ghoststack-rag-ghost-chatui-1`
- `cd /var/Ghost-chatUI && npm run test`
- `cd /var/Ghost-chatUI && npm run build`
