# Browser E2E — Production smoke (2026-04-22)

## Environment

- URL: `https://ghoststack.rideai.com.au/`
- Browser: Cursor IDE browser (embedded)

## Diagnostic evidence (per operator checklist)

- `git status -sb`: working tree dirty (many local changes; branch ahead of origin)
- `docker ps`: `ghoststack-rag-control-api-1`, `ghoststack-rag-agent-ingress-1`, `ghoststack-rag-caddy-1`, etc. (no containers named `ghost-edge-gateway` / `ghost-control-plane` in this environment)
- `docker logs ghost-edge-gateway` / `ghost-control-plane`: **no such container** (expected name drift)

## What was exercised (human-style)

1. **Agent Config** — Opened lead list; selected **Business Strategist**; confirmed stored **system prompt** still begins with `You are RE Business Strategist inside GhostDASH` (not yet the new “Group CFO Architect” text from the local branch).
2. **Embedded GhostChat** — New conversation; sent: `CFO browser smoke test: reply with exactly one line: OK`.
3. **Network** (browser tool): chat failed upstream:
   - `POST https://ghoststack.rideai.com.au/agent/chat/stream` → **502**
   - `GET https://ghoststack.rideai.com.au/api/agents/153ca20f-0864-439f-8b1e-d147f5711917/conversations` → **502** (agent id matches Business Strategist selection)
4. **STRUCTURE** helper — Repo has `STRUCTURE` in `ui/src/pages/chat/ChatComposer.tsx`; **no named “STRUCTURE” control** appeared in the production page accessibility tree (likely **not deployed** or not exposed to a11y snapshot).
5. **Ghost ChatUI** (`/ghost_chatui/`) — Existing thread showed business-structure banking, board-style sections, and BP provisional scorecard content; also a line containing the legacy `Need use odoo tool likely` phrasing in history (downstream presentation vs local `_remove_low_quality_response_artifacts` fix not proven live).

## Follow-up run (same day, after stack healthy)

- Caddy had logged transient **502** during `control-api` / `agent-ingress` restart (`lookup control-api: no such host`, `connection refused` to `agent-ingress:8001`). When ingress and API are **healthy**, the same flow succeeds.
- **Re-test:** `https://ghoststack.rideai.com.au/agent` → GhostChat → agent **Business Strategist** → **New conversation** → message: `Human test: answer with exactly: PASS`.
- **Network:** `POST /agent/chat/stream` → **200**; new conversation id `df992561-6b7e-4371-a2bf-dfadb2872bca`.
- **UI:** Assistant turn visible; page text search finds **PASS** (instruction-following spot-check).
- **Agent tree (production):** Under **Business Strategist** lead, sub-agents **Finance Case Framing**, **Evidence Retrieval**, **Reasoning/Synthesis**, **Odoo Specialist Sub**, **Documentation/Apryse** appear in the list (seed/UI alignment).
- **Friction observed:** With structure gating on, a yellow banner can show *Business-structure question bank is required when structure gating is enabled* while the question bank field is empty on the **currently selected runtime** in the editor (worth reconciling in UX vs guardrails state).

## Conclusion

- **Repository-level verification** of the CFO prompt suite and regressions remains: `pytest` on the listed test modules (see `CFO_ARCHITECT_MULTI_AGENT_PROMPT_SUITE_2026-04-22.md`).
- **Production browser send** is **reliable when Caddy can resolve and reach `control-api` and `agent-ingress`**; during container restarts, expect **502** (not an application-level chat bug).

## Exact re-verify (after deploy / backend fix)

```bash
cd /var/llamaindex/ghoststack-rag && pytest backend/tests/test_runtime_profiles.py backend/tests/test_agent_seed_persistence.py backend/tests/test_agent_builds.py -q
```

```bash
cd /var/llamaindex/ghoststack-rag && pytest backend/tests/test_agent_ingress_prompt_hotfix.py -k "remove_low_quality or normalize_finance_closeout or synthetic_placeholder or context_preface" -q
```

In browser: Agent Config → Business Strategist → new conversation → send one short message; expect **2xx** on `POST /agent/chat/stream` and assistant reply. Optionally confirm **STRUCTURE** control visible in composer on the deployed UI build.

## Burleigh financial anomalies (6 months) — production run (2026-04-22)

- **Setup:** `https://ghoststack.rideai.com.au/agent` → GhostChat → lead **Business Strategist** → **New conversation** → user message (Burleigh, last six months, revenue/margin/COGS/one-offs, Odoo-backed, periods/accounts).
- **Stream:** `POST /agent/chat/stream` → **200** (agent id `153ca20f-0864-439f-8b1e-d147f5711917` = Business Strategist; conversation `c41dd610-4510-4216-8ea8-fd5d8cc201da`).
- **Result (messages API / stored assistant row):** Assistant content was the **“language model returned no usable text”** replacement (empty-generation fallback), *not* a finance answer. `usage`: ~505 in / 160 out (estimate). `route_decision` showed `odoo_ready: true`, `kb_enabled: false`.
- **Human read:** A11y snapshot did not surface the assistant body as searchable text; confirm in UI or `GET /api/conversations/c41dd610-4510-4216-8ea8-fd5d8cc201da/messages` when debugging.

**Verify (read-only, no auth in test curl):**

```bash
curl -sS "https://ghoststack.rideai.com.au/api/conversations/c41dd610-4510-4216-8ea8-fd5d8cc201da/messages" | python3 -m json.tool
```

**Acceptance (for a passing finance run):** assistant `role: assistant` message must contain **grounded** Burleigh/Odoo content (or explicit “cannot retrieve” with tool evidence), **not** the empty-generation replacement template. If replacement repeats, check **agent-ingress** logs for the request trace and provider/parse errors for that turn.
