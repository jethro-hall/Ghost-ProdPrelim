#!/usr/bin/env bash
# End-to-end routing checks against agent-ingress inside the compose network.
set -euo pipefail

BASE_URL="${AGENT_INGRESS_URL:-http://agent-ingress:8001}"
AGENT_ID="${E2E_AGENT_ID:-}"

parse_sse_field() {
  local body="$1"
  local field="$2"
  python3 - "$body" "$field" <<'PY'
import json, re, sys
body, field = sys.argv[1], sys.argv[2]
for block in re.split(r"\n\n+", body.strip()):
    data_lines = [line[5:].strip() for line in block.splitlines() if line.startswith("data:")]
    if not data_lines:
        continue
    try:
        payload = json.loads("\n".join(data_lines))
    except json.JSONDecodeError:
        continue
    if field in payload:
        print(json.dumps(payload[field]))
        raise SystemExit(0)
    if payload.get("type") in {"start", "done"} and field in payload:
        print(json.dumps(payload[field]))
        raise SystemExit(0)
print("")
PY
}

resolve_agent_id() {
  if [[ -n "$AGENT_ID" ]]; then
    echo "$AGENT_ID"
    return
  fi
  curl -sS "${BASE_URL%/}/agent/agents" | python3 - <<'PY'
import json, sys
agents = json.load(sys.stdin)
preferred = next((a for a in agents if "performance" in a.get("name", "").lower()), None)
print((preferred or agents[0])["id"])
PY
}

run_case() {
  local name="$1"
  local payload="$2"
  echo "=== CASE: ${name} ==="
  local body
  body=$(curl -sS -N -X POST "${BASE_URL%/}/agent/chat/stream" \
    -H 'Content-Type: application/json' \
    -d "$payload" | head -c 200000)
  local route_type
  route_type=$(parse_sse_field "$body" route_decision | python3 - <<'PY' || true
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    print("MISSING")
    raise SystemExit(0)
obj = json.loads(raw)
print(obj.get("route_type", "MISSING"))
PY
)
  local citation_count
  citation_count=$(python3 - <<'PY' "$body"
import json, re, sys
body = sys.argv[1]
count = 0
for block in re.split(r"\n\n+", body.strip()):
    data_lines = [line[5:].strip() for line in block.splitlines() if line.startswith("data:")]
    if not data_lines:
        continue
    try:
        payload = json.loads("\n".join(data_lines))
    except json.JSONDecodeError:
        continue
    if payload.get("type") == "done":
        count = len(payload.get("citations") or [])
        break
print(count)
PY
)
  echo "route_type=${route_type}"
  echo "citation_count=${citation_count}"
  echo "$body" | grep -q 'chat.route_decision' && echo "log_marker=present" || echo "log_marker=n/a_in_body"
  echo
}

AGENT_ID="$(resolve_agent_id)"
echo "Using agent_id=${AGENT_ID}"
echo "Base URL=${BASE_URL}"
echo

run_case "bare_direct_hello" "$(cat <<JSON
{
  "message": "hello",
  "agent_id": "${AGENT_ID}",
  "surface": "ghost_chatui",
  "conversation_mode": "quick",
  "workflow_mode": "standard",
  "tool_overrides": {"kb": false, "odoo_primary": false, "inline_workers": false}
}
JSON
)"

run_case "tools_on_greeting" "$(cat <<JSON
{
  "message": "hello",
  "agent_id": "${AGENT_ID}",
  "surface": "ghost_chatui",
  "conversation_mode": "quick",
  "workflow_mode": "standard",
  "tool_overrides": {"kb": true, "odoo_primary": true, "inline_workers": false}
}
JSON
)"

echo "E2E routing script completed."
