#!/usr/bin/env bash
# Deploy customer-by-phone jobcard enrichment (hubtiger-proxy + control-api).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Deploy customer-by-phone from: $ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

docker compose config >/dev/null
docker compose up -d --build hubtiger-proxy hubtiger-mcp control-api

echo "==> Waiting for health (hubtiger-proxy, control-api)..."
for _ in $(seq 1 30); do
  proxy_ok=0
  api_ok=0
  docker compose exec -T hubtiger-proxy wget -qO- http://127.0.0.1:8095/health >/dev/null 2>&1 && proxy_ok=1 || true
  docker compose exec -T control-api wget -qO- http://127.0.0.1:8000/health >/dev/null 2>&1 && api_ok=1 || true
  if [[ "$proxy_ok" -eq 1 && "$api_ok" -eq 1 ]]; then
    break
  fi
  sleep 2
done

echo "==> Done. Verify with:"
echo "  export GHOST_VOICE_KEY=\$(grep -E '^ELEVENLABS_HUBTIGER_WEBHOOK_SECRET=' .env | cut -d= -f2-)"
echo '  curl -sS -X POST "https://ghoststack.rideai.com.au/api/elevenlabs/hubtiger/customer-by-phone" \'
echo '    -H "Content-Type: application/json" -H "X-Ghost-Voice-Key: $GHOST_VOICE_KEY" \'
echo '    -d "{\"phone\":\"0435185134\"}" | jq .'
