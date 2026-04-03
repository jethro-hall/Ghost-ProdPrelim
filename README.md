# ghoststack-rag

LlamaIndex **RAG** workflow served by **LlamaDeploy** (`llamactl serve`) behind **Caddy** with automatic HTTPS for `ghoststack.rideai.com.au`.

> This stack uses **LlamaIndex / LlamaDeploy**, not Meta Llama Stack. Map concepts separately if you adopt Llama Stack APIs later.

## Security

- **Never commit `OPENAI_API_KEY`.** Use `.env` (see `.env.example`).
- If an API key was shared in chat or tickets, **rotate it** in the OpenAI dashboard immediately.

## Quick start (Docker)

1. Copy env and set your key:

   ```bash
   cp .env.example .env
   # edit .env — set OPENAI_API_KEY only here
   ```

2. Point **DNS** `ghoststack.rideai.com.au` A/AAAA records to this host (required for Let’s Encrypt).

3. Start:

   ```bash
   docker compose up -d --build
   ```

4. Open **HTTPS**:

   - API docs: `https://ghoststack.rideai.com.au/deployments/rag/docs`
   - Health: `https://ghoststack.rideai.com.au/health`

## Invoke the RAG workflow

Use the OpenAPI UI at `/deployments/rag/docs` to discover the workflow run endpoint (typically under `/deployments/rag/workflows/...`). Pass a **host-mounted document path** inside the container (e.g. mount files under `/data` via the `rag_data` volume and use `/data/your-folder` as `path` in the start event—adjust per API schema).

## Local development (no TLS)

From `app/`:

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e "."
export OPENAI_API_KEY=...  # do not commit
llamactl serve --host 127.0.0.1 --port 4501
```

## Layout

| Path | Purpose |
|------|---------|
| `app/` | Python package `rag`, `pyproject.toml`, Dockerfile |
| `docker-compose.yml` | `rag` + `caddy` services |
| `Caddyfile` | TLS + reverse proxy to `rag:4501` |
| `docs/ARCHITECTURE.md` | Build and runtime architecture |

## GitHub

Create and push (example):

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create ghoststack-rag --private --source=. --push
```
