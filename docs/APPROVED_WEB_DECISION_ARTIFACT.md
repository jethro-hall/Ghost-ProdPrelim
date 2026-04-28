## Approved Web Decision Artifact

### Goal

Decide whether the in-flight approved-web feature should ship in Phase 2, and enforce a clean architecture boundary so it does not create a second settings surface or unpredictable fetch behavior.

### Decision

Ship approved web in Phase 2.

But ship it only under these constraints:

- tool policy remains owned by the agent runtime profile
- `Agent Config` is the only editable surface for:
  - web tool enablement
  - allowed URLs
- `GhostChat` may only request one-off use through `use_approved_web`
- backend auto-use must be explicit and explainable

### Problem found

The in-flight feature was architecturally close, but not yet safe to ship:

1. `backend/src/ghostdash_api/approved_web.py` existed but was still untracked.
2. `ui/src/components/GhostChat.tsx` was mutating agent tool policy through `saveAgent`, which duplicated the canonical edit surface already present in `ui/src/pages/AgentConfigPage.tsx`.
3. `should_use_approved_web_context()` still allowed broad business-word heuristics such as `pricing`, `strategy`, and `product`, which could trigger web fetches without a sufficiently explicit user signal.

That combination would have shipped a half-wired feature with duplicated ownership and surprising runtime behavior.

### Changes applied

Updated `backend/src/ghostdash_api/approved_web.py`:

- kept allowlist normalization and bounded fetch behavior
- changed the decision policy so approved-web runs only when:
  - `use_approved_web` is forced and sources exist
  - the user explicitly asks to check a site/web/website
  - the user message names one of the configured domains
- removed the broad value-add fallback heuristic

Updated `ui/src/components/GhostChat.tsx`:

- removed chat-side persistence of web tool enablement and URL configuration
- removed the duplicate `saveAgent`-driven editor from the chat drawer
- kept a per-message `Force approved web use for this message` checkbox
- changed the tools drawer to read-only status:
  - tool enabled/disabled
  - stored allowlisted URLs
  - instruction to configure sources in `Agent Config`
- automatically clears the force checkbox when the selected agent has no enabled approved-web sources

Added focused backend tests in `backend/tests/test_approved_web.py`:

- allowlist normalization
- force-use behavior
- explicit-or-domain-match trigger policy
- refusal to auto-use on broad business hints alone

### Why this is fit for purpose

- It preserves the Milestone 1 single-source-of-truth rule.
- It keeps the feature LlamaIndex-native in the right way:
  - retrieval/chat path consumes runtime-profile metadata
  - chat requests may pass a one-turn override
  - chat does not become a second admin screen
- It keeps web fetching bounded and auditable through:
  - a maximum of two stored URLs
  - explicit citations with `corpus: approved_web`
  - disabled response cache when web context is used
- It makes every approved-web fetch easier to explain to the operator.

### Verification performed

Repo/runtime evidence checked first:

- `git status -sb`
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'`
- `docker logs --tail=120 ghoststack-rag-caddy-1`
- `docker logs --tail=120 ghoststack-rag-control-api-1`

Automated verification:

- `python3.12 -m compileall backend/src`: passed
- `PYTHONPATH=src pytest tests/test_approved_web.py -q`: passed
- `npm run lint`: passed after fixing one TypeScript import regression in `GhostChat`

Human QA:

- rebuilt `control-api`, `agent-ingress`, and `ui`
- opened `Agent Config`
- confirmed approved-web enablement and URL fields remain editable there
- opened `GhostChat`
- confirmed the tools drawer no longer exposes:
  - URL inputs
  - web-tool enable toggle
- confirmed the drawer now shows:
  - read-only tool status
  - read-only allowed source list
  - one per-message force checkbox only

Live runtime verification:

- direct `POST /agent/chat` with `use_approved_web: true` returned:
  - `cached: false`
  - `query_mode: semantic`
  - `approved_web` citations for:
    - `https://www.rideelectric.com.au`
    - `https://www.qld.gov.au`
- agent-ingress logs showed successful `/agent/chat/stream` handling and downstream OpenAI response streaming without new backend errors

### Issues found and repaired

Issue found during checks:

- `npm run lint` failed because `GhostChat.tsx` still referenced `AgentProfile` after the import had been removed during cleanup

Repair:

- restored the missing type import
- reran lint successfully

### Acceptance criteria

- approved-web settings are editable in exactly one place: met
- chat can still request one-off approved-web use without editing policy: met
- backend no longer auto-fetches on vague business hints alone: met
- focused backend tests cover the trigger policy: met
- live approved-web answer path returns approved-web citations: met

### Exact verify commands

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 -m compileall backend/src
cd backend && PYTHONPATH=src pytest tests/test_approved_web.py -q
cd ../ui && npm run lint
```

```bash
cd /var/llamaindex/ghoststack-rag
docker compose up -d --build control-api agent-ingress ui
docker ps --format 'table {{.Names}}\t{{.Status}}'
docker logs --tail=120 ghoststack-rag-agent-ingress-1
```

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 - <<'PY'
import json, urllib.request
payload = {
    "message": "Use the approved web sources and give me two concise bullets about Ride Electric's website. Mention what you actually checked.",
    "api_mode": "responses",
    "use_approved_web": True,
}
req = urllib.request.Request(
    "http://localhost/agent/chat",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
print(urllib.request.urlopen(req, timeout=120).read().decode())
PY
```

### Human retest request

Please retest this flow in the UI:

1. Open `Agent Config` and verify approved-web enablement and URLs are editable there.
2. Open `GhostChat`, open the tools drawer, and confirm those settings are no longer editable there.
3. Force approved web for one message and confirm the answer reflects checked sources and returns citations.
