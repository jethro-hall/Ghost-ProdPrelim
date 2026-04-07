# Operations — stack reset and hygiene

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

## Verify

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
curl -sS http://127.0.0.1/health
curl -sS https://ghoststack.rideai.com.au/health
```
