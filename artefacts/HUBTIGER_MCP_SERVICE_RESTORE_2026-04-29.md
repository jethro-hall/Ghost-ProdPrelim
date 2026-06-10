# HubTiger MCP Service Restore - 2026-04-29

## Requirement

Restore `hubtiger-mcp` as a first-class Docker service under `services/hubtiger-mcp`, ensure `control-api` resolves it on Docker DNS, and verify `/execute` accepts canonical `operation + payload` contract with nested customer phone mapping.

## Files Changed

- `services/hubtiger-mcp/package.json`
- `services/hubtiger-mcp/index.js`
- `services/hubtiger-mcp/Dockerfile`
- `services/hubtiger-mcp/.dockerignore`
- `scripts/hubtiger/hubtiger-mcp/index.js`
- `docker-compose.yml`
- `.env`

## Architecture Impact

- `hubtiger-mcp` build context now points to `./services/hubtiger-mcp`.
- MCP runtime in service directory is self-contained for Docker build.
- `/execute` supports both low-level MCP contract and canonical control-api contract.
- `job_lookup` mapper now reads nested `payload.customer.phone`/`mobile`.
- `control-api` continues to target `HUBTIGER_MCP_URL=http://hubtiger-mcp:8096`.

## Verification Commands And Results

1. Service declared:
   - `docker compose config --services | rg '^hubtiger-mcp$'`
   - Result: `hubtiger-mcp`

2. Service running:
   - `docker compose ps | rg 'hubtiger-mcp'`
   - Result: container `Up ... (healthy)`

3. DNS from control-api:
   - `docker compose exec control-api sh -lc 'getent hosts hubtiger-mcp'`
   - Result: `172.28.0.12 hubtiger-mcp`

4. MCP health from control-api:
   - `python/httpx` call to `$HUBTIGER_MCP_URL/health`
   - Result: `200`, `{"ok":true,"service":"hubtiger-mcp","hubtiger_proxy_url":"http://hubtiger-proxy:8095"...}`

5. Execute mapping proof:
   - `python/httpx` POST to `$HUBTIGER_MCP_URL/execute` with:
     - `operation=job_lookup`
     - `payload.phone=+61435185134`
     - `payload.customer.phone=+61435185134`
   - Result: `503` from upstream (`HUBTIGER_BASE_URL not set`), and importantly **not** `400 invalid_mcp_execute_request`.

6. Public health route:
   - Without key: `401` (not `404`)
   - With key: `200` with `ready:true`

7. Public lookup endpoint:
   - `POST /api/elevenlabs/hubtiger/tool` with `{"function":"lookup_job","phone":"0435185134"}`
   - Result: safe failure envelope with no internal stack or trace leakage.

## Human QA Notes

- Public route behavior is operator-safe:
  - no DNS trace leakage
  - no raw MCP/proxy stack errors
  - no backend stack traces
- Existing user path remains functional and returns recoverable message when upstream HubTiger base URL is not configured.

## Cleanup Performed

- Removed non-working service wrapper approach and copied full MCP runtime into `services/hubtiger-mcp/index.js` for deterministic Docker build behavior.

## Known Risks

- Upstream HubTiger proxy target is still not fully configured (`HUBTIGER_BASE_URL` absent), so lookups correctly fail-safe rather than return live data.
- `scripts/hubtiger/hubtiger-mcp/index.js` and `services/hubtiger-mcp/index.js` are duplicated and can drift unless consolidated in a future cleanup pass.
