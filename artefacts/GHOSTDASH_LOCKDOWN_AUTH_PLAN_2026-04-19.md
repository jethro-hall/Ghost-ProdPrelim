# GhostDASH + Ghost ChatUI Lockdown Plan (2026-04-19)

## Objective

Lock down GhostDASH and Ghost ChatUI with admin-grade authentication and authorization using open-source, battle-tested components instead of custom auth.

## Recommended OSS approach (best-practice)

Use **OIDC with Keycloak** (or Authentik as alternative) plus edge enforcement.

### Why Keycloak

- widely adopted OSS identity provider
- supports OIDC/OAuth2/SAML
- role/group claims for RBAC
- MFA, session policies, password policies
- admin UI and audit capabilities

## Target Architecture

1. User hits `caddy` edge.
2. `caddy` forwards auth checks to auth gateway (`oauth2-proxy` with Keycloak OIDC).
3. Valid session required before reaching:
   - GhostDASH UI
   - Ghost ChatUI
   - Control/API endpoints
4. Backend validates JWT/access token and applies role-based authorization.

## Phased rollout

### Phase 1: Edge login enforcement

- Add `keycloak` + `oauth2-proxy` services in compose.
- Require auth for `/`, `/chat`, `/ghost_chatui`, `/api/*`, `/agent/*`.
- Allow only `/health` unauthenticated.

### Phase 2: API token verification + RBAC

- Backend middleware validates OIDC JWT signature, issuer, audience.
- Enforce roles:
  - `ghostdash_admin` (full config/policy edit)
  - `ghostdash_operator` (run/report/chat, no critical policy writes)
  - `ghostdash_viewer` (read-only)

### Phase 3: Admin hardening

- MFA required for admin roles.
- session timeout + idle timeout.
- brute-force protection, lockout policies.
- audit log ingestion for auth events.

### Phase 4: Least privilege + break-glass

- restrict service-to-service creds
- no shared admin accounts
- documented break-glass account workflow with rotation

## Non-goals

- no custom homegrown login service
- no hardcoded user/password in app code

## Acceptance Criteria

1. Unauthenticated requests cannot access GhostDASH or Ghost ChatUI.
2. API endpoints require valid OIDC token.
3. Admin-only settings/config writes are blocked for non-admin roles.
4. MFA enforced for admin role.
5. Auth events are auditable.

## Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
git status -sb
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker logs --tail=120 ghoststack-rag-caddy-1
docker logs --tail=120 ghoststack-rag-control-api-1
```

```bash
# unauthenticated should fail
curl -i http://localhost/api/agents

# authenticated should pass (token from OIDC login flow)
curl -i http://localhost/api/agents -H "Authorization: Bearer <access-token>"
```
