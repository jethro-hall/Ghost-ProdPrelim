---
name: docker-drift-check
description: Detect drift between repo config and the running GhostDASH Docker stack.
---

# Skill: Docker Drift Check

## Goal

Confirm the running stack matches repo reality.

## Commands

1. Repo state
- `git status -sb`
- `docker compose config`

2. Container state
- `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'`

3. Caddy mount verification
- `docker inspect ghoststack-rag-caddy-1 --format '{{json .Mounts}}'`

## Drift to flag

- Running containers that do not match `docker-compose.yml`
- Caddy not mounting `./Caddyfile` to `/etc/caddy/Caddyfile`
- Ports/routes in `Caddyfile` not matching compose listeners
