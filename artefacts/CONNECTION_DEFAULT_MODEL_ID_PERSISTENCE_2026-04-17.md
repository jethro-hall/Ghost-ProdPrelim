# Connection default model id persistence

## Change

The `connections` table now includes optional `default_model_id` (VARCHAR 256). GhostDASH `GET/POST /api/connections` exposes it; the Connections right panel persists the **Test model id** field to this column. When null, the UI falls back to global runtime defaults `llm_model_id` for display and tests.

## Verify

```bash
cd /var/llamaindex/ghoststack-rag/backend && python3.12 -m pytest tests/test_connections_and_bootstrap.py tests/test_connections_test_endpoint_regression.py -q
```

```bash
curl -fsS http://localhost/api/connections | jq '.[] | {provider, label, default_model_id}'
```

Human: open Manage providers, set Test model id, Save connection, close and reopen — value must match what was saved.
