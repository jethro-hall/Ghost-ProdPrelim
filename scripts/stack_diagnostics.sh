#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

docker compose config >/dev/null

PROJECT_NAME="$(docker compose config | awk '/^name:/ { print $2; exit }')"

echo "Compose project: ${PROJECT_NAME}"
echo
echo "Container state:"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
echo

python3 - <<'PY'
import json
import subprocess
import sys

required_services = ["caddy", "control-api", "agent-ingress", "workflow-runtime"]

try:
    output = subprocess.check_output(
        ["docker", "compose", "ps", "--format", "json"],
        text=True,
    )
except subprocess.CalledProcessError as exc:
    raise SystemExit(exc.returncode) from exc

rows = [json.loads(line) for line in output.splitlines() if line.strip()]
by_service = {row["Service"]: row for row in rows}

print("Canonical diagnostics targets:")
for service in required_services:
    row = by_service.get(service)
    if row is None:
        print(f"- {service}: not running", file=sys.stderr)
        continue
    print(f"- {service}: {row['Name']}")

print()
print("Exact verify commands:")
print("git status -sb")
print("docker compose config")
print("docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Ports}}\\t{{.Status}}'")
for service in required_services:
    row = by_service.get(service)
    if row is None:
        continue
    print(f"docker logs --tail=120 {row['Name']}")
PY
