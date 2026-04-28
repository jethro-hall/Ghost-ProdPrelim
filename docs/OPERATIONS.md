# Operations — stack reset and hygiene

## Canonical stack naming

This stack is named by Docker Compose project + service, so live containers appear as:

- `ghoststack-rag-caddy-1`
- `ghoststack-rag-control-api-1`
- `ghoststack-rag-agent-ingress-1`
- `ghoststack-rag-workflow-runtime-1`

Legacy names like `ghost-edge-gateway` and `ghost-control-plane` belong to older reference material and are not valid diagnostics targets for this repo.

Use the repo-owned resolver instead of hardcoding container names:

```bash
./scripts/stack_diagnostics.sh
```

That script derives the live container names from `docker compose ps` and prints the exact `docker logs` commands to use.

For the mandatory 4-step diagnostics protocol compatibility, use:

```bash
./scripts/required_diagnostics.sh
```

This command preserves the required sequence (`git status`, `docker ps`, edge logs, control-plane logs) while mapping legacy names to this repo's canonical containers when needed.

## Controlled teardown (this repo only)

From the repository root:

```bash
docker compose down -v
```

This stops services and removes named volumes (`app_data`, `qdrant_data`, `stack_data`, `caddy_data`, `caddy_config`). Application SQLite data, Qdrant vectors, Llama Stack local stores, and TLS state are wiped.

Before running:

- Ensure `.env` secrets are backed up if needed.
- Git history and the GitHub remote are unaffected.

## Optional global Docker cleanup

Only if you accept removing unused images and containers across the host:

```bash
docker system prune -af
```

This is not run automatically by this project.

## Bring the stack back

```bash
docker compose config
docker compose up -d --build
```

## TLS / DNS

Production HTTPS uses Caddy automatic certificates when `ghoststack.rideai.com.au` resolves to the host and ports `80` and `443` are reachable.

## Edge sites and canonical operator chat

From `Caddyfile`, this host exposes:

- **`ghoststack.rideai.com.au`**: GhostDASH UI (`ui`), Ghost ChatUI at **`/ghost_chatui/`** (`ghost-chatui`), `control-api` (`/api/*`), `agent-ingress` (`/agent/*`), `docx-templater` (`/docx-artifacts/*`), `/health`, and Qdrant on **`https://ghoststack.rideai.com.au:6333`**.
- **`workflow.rideai.com.au`**: `n8n` workflow UI.
- **Port `:80`**: same upstream shape for local HTTP (with redirects to HTTPS where configured).

Canonical operator chat **browser** URL: **`https://ghoststack.rideai.com.au/ghost_chatui/`**. Requests to **`/chat`** or **`/chat/*`** receive **308** to **`/ghost_chatui/`** (legacy GhostDASH SPA route must not be used in runbooks or user-facing links).

## Verify

```bash
./scripts/stack_diagnostics.sh
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
curl -sS http://127.0.0.1/health
curl -sS https://ghoststack.rideai.com.au/health
```
