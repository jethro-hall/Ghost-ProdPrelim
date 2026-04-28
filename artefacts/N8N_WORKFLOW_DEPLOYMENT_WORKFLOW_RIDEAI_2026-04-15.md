# n8n deployment — `workflow.rideai.com.au` (2026-04-15)

## Goal
Run the latest `n8nio/n8n` in Docker with its own Postgres DB container, and expose it via Caddy at:

- https://workflow.rideai.com.au

## What was changed

### Docker
`docker-compose.yml` now includes:

- `n8n` (image: `n8nio/n8n:latest`)
- `n8n-db` (image: `postgres:16-alpine`)
- persistent volumes:
  - `n8n_data` → `/home/node/.n8n`
  - `n8n_postgres_data` → `/var/lib/postgresql/data`

### Reverse proxy (Caddy)
`Caddyfile` now includes a dedicated site block:

- `workflow.rideai.com.au` → `reverse_proxy n8n:5678`

## Runtime configuration

### `.env` (server-local, gitignored)
Required:

- `N8N_DB_PASSWORD`
- `N8N_ENCRYPTION_KEY` (must stay stable; rotating invalidates stored credentials)

n8n is configured for correct public URLs:

- `WEBHOOK_URL=https://workflow.rideai.com.au/`
- `N8N_EDITOR_BASE_URL=https://workflow.rideai.com.au/`
- `N8N_HOST=workflow.rideai.com.au`
- `N8N_PROTOCOL=https`
- `N8N_PROXY_HOPS=1`
- `N8N_SECURE_COOKIE=true`

Timezone:

- `GENERIC_TIMEZONE=Australia/Sydney`

## Operations

### Start / update n8n only
From `ghoststack-rag/`:

```bash
docker compose up -d n8n-db n8n
```

### Reload Caddy config
```bash
docker exec ghoststack-rag-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

## Verification checklist (human + CLI)

### CLI
```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
curl -I https://workflow.rideai.com.au
docker logs --tail=200 ghoststack-rag-caddy-1
docker logs --tail=200 ghoststack-rag-n8n-1
```

### Human (browser)
- Load https://workflow.rideai.com.au and confirm n8n UI loads.
- Create an account (or first-user bootstrap) and log in.
- Create a test workflow with a webhook trigger and confirm the webhook URL uses `workflow.rideai.com.au`.
- Restart `n8n` and confirm the workflow and credentials remain present.

## Rollback
- Remove the `workflow.rideai.com.au` block from `Caddyfile` and reload Caddy.
- Stop n8n services:

```bash
docker compose stop n8n n8n-db
```

