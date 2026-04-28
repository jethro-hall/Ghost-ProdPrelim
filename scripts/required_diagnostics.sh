#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

resolve_container() {
  local preferred="$1"
  local fallback="$2"

  if docker ps --format '{{.Names}}' | rg -x --quiet "$preferred"; then
    echo "$preferred"
    return 0
  fi

  if docker ps --format '{{.Names}}' | rg -x --quiet "$fallback"; then
    echo "$fallback"
    return 0
  fi

  return 1
}

EDGE_CONTAINER="$(resolve_container "ghost-edge-gateway" "ghoststack-rag-caddy-1" || true)"
CONTROL_CONTAINER="$(resolve_container "ghost-control-plane" "ghoststack-rag-control-api-1" || true)"

echo "# 1) git status -sb"
git status -sb
echo

echo "# 2) docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Ports}}'"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
echo

if [[ -n "${EDGE_CONTAINER}" ]]; then
  if [[ "${EDGE_CONTAINER}" == "ghost-edge-gateway" ]]; then
    echo "# 3) docker logs --tail=120 ghost-edge-gateway"
  else
    echo "# 3) docker logs --tail=120 ghost-edge-gateway (mapped to ${EDGE_CONTAINER})"
  fi
  docker logs --tail=120 "${EDGE_CONTAINER}"
else
  echo "# 3) docker logs --tail=120 ghost-edge-gateway"
  echo "No matching edge container found (checked ghost-edge-gateway, ghoststack-rag-caddy-1)."
fi
echo

if [[ -n "${CONTROL_CONTAINER}" ]]; then
  if [[ "${CONTROL_CONTAINER}" == "ghost-control-plane" ]]; then
    echo "# 4) docker logs --tail=120 ghost-control-plane"
  else
    echo "# 4) docker logs --tail=120 ghost-control-plane (mapped to ${CONTROL_CONTAINER})"
  fi
  docker logs --tail=120 "${CONTROL_CONTAINER}"
else
  echo "# 4) docker logs --tail=120 ghost-control-plane"
  echo "No matching control container found (checked ghost-control-plane, ghoststack-rag-control-api-1)."
fi
