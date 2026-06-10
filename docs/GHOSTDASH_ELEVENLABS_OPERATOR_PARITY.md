# GhostDASH vs ElevenLabs — Operator Parity

Goal: **day-to-day Ride Electric voice ops happen in GhostDASH**, not the ElevenLabs dashboard.

Console URL: **`/analysis/voice-ops`** (Voice Operator Console)

---

## Parity matrix

| Task | ElevenLabs UI | GhostDASH (no EL login) | Notes |
|------|---------------|-------------------------|-------|
| Test HubTiger availability | Tool test in agent | **Booking lab** (two-tool step 1), **Tools** page, **Simulator → Booking** | Live via `/api/hubtiger/test` |
| Create booking | Tool test in agent | **Booking lab** step 2 `booking_create` | Same webhook path as production |
| Staged booking (8 tools) | Workflow nodes | **Booking lab → Staged**, Simulator | `booking_session_id` in session |
| Edit Magic Mike system prompt | Agent instructions | **Voice Ops → Prompts**, **Agent Config**, **Simulator → System prompt** | Postgres runtime profile = source of truth for GhostDASH |
| Chat test Magic Mike | Agent preview | **Simulator → Chat** (`agent-ingress`) | Not ElevenLabs ConvAI |
| Step-by-step call replay | Test workbench | **Test Workbench** (`/analysis/test-workbench`) | Uses EL API from server if `ELEVENLABS_API_KEY` set |
| View tool JSON definitions | Tool import UI | **Voice Ops → Tool catalog** | Reads `scripts/hubtiger/*.json` from repo mount |
| Copy tool JSON for production | Tool export | **Tool catalog → Copy JSON** | One-time manual import |
| Push nine booking tools to EL | Tool editor | **Tool catalog → Preview / Dry-run / Live sync** | Admin-gated; GhostDASH sync utility only — not Magic Mike control plane |
| HubTiger connection status | — | **Voice Ops overview**, **Tools** | |
| Call analysis / transcripts | Conversations | **Call Analysis** | |
| Simulation packs | Tests | **Test Workbench → Simulation** | Optional EL API |

---

## Still requires ElevenLabs (or telco) — rare

| Task | Why | GhostDASH helps |
|------|-----|-----------------|
| **Production phone number** on ConvAI agent | Telco / ElevenLabs telephony | GhostDASH routes webhooks only |
| **Initial ConvAI agent create** + attach phone | EL account | Import tool JSON from Voice Ops catalog |
| **Voice clone / TTS library** | EL media assets | Use `voice_id` in Agent Config |
| **Full workflow graph editing** | EL visual editor | Use **two-tool** or **staged** map in docs; test in Booking lab |
| **Push prompt to EL agent** (optional) | No write API in GhostDASH yet | Peek via Test Workbench agent API; manual paste if needed |

---

## Recommended operator workflow (no ElevenLabs login)

1. **Voice Ops → Booking lab** — run availability, then create with real fields.
2. **Simulator** (header) — chat as Magic Mike with prompt override; save prompt when happy.
3. **Test Workbench** — regression on simulation JSON packs (optional).
4. **Call Analysis** — review production calls.
5. **Production EL agent** — only when changing telephony or importing updated tool JSON (copy from Tool catalog).

---

## Environment

| Variable | Purpose |
|----------|---------|
| `ELEVENLABS_API_KEY` | Simulation + remote tool list (optional) |
| `APP_OPERATOR_ADMIN_KEY` | Admin gate for ElevenLabs tool sync (`X-Operator-Admin-Key`) |
| `ELEVENLABS_CONVAI_AGENT_ID` | Default agent for workbench runs (optional attach target) |
| `ELEVENLABS_HUBTIGER_WEBHOOK_SECRET` | Production tool auth |
| `HUBTIGER_TOOL_ACCESS=read_write` | Booking writes |
| `HUBTIGER_ELEVENLABS_TOOL_DIR` | Tool catalog mount (`/app/hubtiger-tools` in compose) |

---

## APIs (GhostDASH-owned)

| Route | Purpose |
|-------|---------|
| `POST /api/elevenlabs/hubtiger/tool` | Production HubTiger tools (ElevenLabs + GhostDASH) |
| `POST /api/hubtiger/test` | Operator test console |
| `GET /api/elevenlabs/operator/*` | Voice Ops console |
| `POST /agent/chat/stream` | Simulator chat |
| `/api/elevenlabs/tests/*` | Test workbench |

---

## Roadmap (100% parity)

- [ ] Push/sync system prompt to ElevenLabs ConvAI agent from GhostDASH (write API)
- [ ] Register/update EL tools from repo JSON without manual import
- [ ] In-dashboard workflow graph (mirror two-tool / staged nodes)
- [ ] Postgres persistence for simulation run history
- [ ] Embedded ConvAI WebRTC test call from dashboard (optional)
