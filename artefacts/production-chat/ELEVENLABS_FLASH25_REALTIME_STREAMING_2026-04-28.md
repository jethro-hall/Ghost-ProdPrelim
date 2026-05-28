# ElevenLabs Flash 2.5 Realtime Streaming

## Scope

Implemented `scripts/ghostdash_elevenlabs_flash25_realtime.zip` as the only browser voice streaming path for both chat surfaces:

- `/ghost_chatui/`
- `/prod_chatui/`

Normal LLM text streaming remains on the existing chat stream because the Flash 2.5 package is a realtime TTS bridge that consumes LLM text deltas and streams PCM audio.

## Architecture

```text
LLM streaming deltas
-> React shared Flash 2.5 realtime speech hook
-> /api/voice/elevenlabs/flash25/realtime WebSocket
-> agent-ingress FastAPI router
-> ElevenLabs stream-input WebSocket
-> PCM chunks
-> browser AudioContext playback
```

## Backend Changes

- Added `backend/src/ghostdash_api/elevenlabs_flash25_realtime.py` from the supplied package.
- Included the router in `agent_ingress.create_app()`.
- Routed `/api/voice/elevenlabs/*` through Caddy to `agent-ingress`.
- Decommissioned the old agent-ingress WebSocket registrations:
  - `/agent/voice/stream`
  - `/agent/voice/tts-stream`
- Kept `/agent/voice/preview` for non-streaming voice preview/admin use.

## Frontend Changes

- Added `src/lib/elevenFlash25RealtimeClient.ts` from the supplied package.
- Added `src/lib/useElevenFlash25RealtimeSpeech.ts` as the shared integration hook.
- Updated `/ghost_chatui/` to use the shared Flash 2.5 realtime client instead of the older custom MP3 queue and browser/HTTP fallback speech path.
- Updated `/prod_chatui/` to expose the same Flash 2.5 realtime speech toggle and stop control.
- Removed frontend URL builders for the old `/agent/voice/stream` and `/agent/voice/tts-stream` paths.

## Findings And Fixes

- Found the old running containers did not include the new backend module because backend services are image-built, not source-mounted.
  - Fixed by rebuilding `agent-ingress`, `ghost-chatui`, and `caddy`.
- Browser testing found the production empty-state headline inherited unreadable light text on a light background.
  - Fixed by explicitly setting readable slate text for the empty state.

## Verification

Commands run:

```bash
git status -sb
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
python3 -m compileall backend/src/ghostdash_api/elevenlabs_flash25_realtime.py backend/src/ghostdash_api/agent_ingress.py
npm run lint
npm run build
docker compose up -d --build agent-ingress ghost-chatui caddy
docker compose exec -T agent-ingress python - <<'PY'
from ghostdash_api.agent_ingress import create_app
app = create_app()
routes = sorted(getattr(route, 'path', '') for route in app.routes)
print('/api/voice/elevenlabs/flash25/realtime' in routes)
PY
docker compose exec -T agent-ingress python - <<'PY'
import asyncio, json, websockets

async def main():
    async with websockets.connect('ws://caddy/api/voice/elevenlabs/flash25/realtime') as ws:
        await ws.send(json.dumps({'type': 'start'}))
        print(await ws.recv())

asyncio.run(main())
PY
docker logs --tail=120 ghoststack-rag-caddy-1
docker logs --tail=120 ghoststack-rag-control-api-1
docker logs --tail=120 ghoststack-rag-agent-ingress-1
```

Observed:

- TypeScript typecheck passed.
- Vite production build passed.
- Python compile passed.
- Rebuilt route registration returned `True`.
- Gateway WebSocket smoke test returned a safe validation error from `/api/voice/elevenlabs/flash25/realtime`.
- Caddy, control API, and agent ingress logs showed healthy startup/health checks after rebuild.
- Browser smoke confirmed `/ghost_chatui/` loads.
- Browser smoke confirmed `/prod_chatui/` loads and the production empty state is readable after the contrast fix.

## Acceptance Criteria

- `/ghost_chatui/` no longer uses the old custom ElevenLabs TTS stream.
- `/prod_chatui/` uses the same Flash 2.5 realtime voice path.
- The old `/agent/voice/tts-stream` frontend path is decommissioned.
- Caddy routes `/api/voice/elevenlabs/flash25/realtime` to `agent-ingress`.
- ElevenLabs API key remains server-side only.
- Stop/cancel uses the packaged realtime client cancellation path.
- Both chat routes load in a browser after deployment.
