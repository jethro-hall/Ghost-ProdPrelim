# SHOPIFY_MCP_TOOL Complete Implementation Guide

Standalone architecture and execution guide for `SHOPIFY_MCP_TOOL`.

---

## 1) Standalone Architecture

### Public entrypoint

- `POST https://ghoststack.rideai.com.au/api/elevenlabs/shopify/tool`
- `GET https://ghoststack.rideai.com.au/api/elevenlabs/shopify/health`

### Service flow

1. OpenAI/voice tool webhook call
2. Caddy `/api/*` routing
3. `control-api` Shopify bridge auth and request normalization
4. `shopify-mcp` sidecar `/execute`
5. Shopify Admin GraphQL
6. Public-safe response shaping

### Boundary

- `SHOPIFY_MCP_TOOL` is standalone.
- Auth, payload, and response handling are Shopify-only.

---

## 2) Supported Operations

- `connection_check`
- `product_search`

Aliases:

- `ping`, `shop_info`, `shop_ping` -> `connection_check`
- `products_search`, `search_products` -> `product_search`

---

## 3) Workflow Logic

### 3.1 Connection check

1. call `connection_check`
2. if success, continue to product flow
3. if failure, give safe fallback and handoff action

### 3.2 Product search

1. extract search term
2. set category when known (`part`, `ebike`, `scooter`, `all`)
3. call `product_search`
4. if stale complaint, retry once with `cache_mode: bypass`
5. return concise customer-safe summary

### 3.3 Failure handling

- never expose GraphQL internals to customers
- provide practical fallback ("I can check this manually now and confirm shortly.")

---

## 4) Deterministic LLM Rules

1. Use only supported SHOPIFY_MCP_TOOL functions.
2. Never claim price/availability unless `success=true`.
3. Ask one focused follow-up on vague product requests.
4. Retry stale results once only with `cache_mode=bypass`.
5. Never return raw payloads, traces, headers, or backend diagnostics publicly.

---

## 5) LLM Interaction Examples

### Example A

Caller: "Do you have Fatfish OG in stock?"

```json
{
  "function": "product_search",
  "payload": {
    "search": "Fatfish OG",
    "category": "ebike",
    "first": 3
  }
}
```

### Example B (stale)

Caller: "That sounds old, I got a different update."

```json
{
  "function": "product_search",
  "payload": {
    "search": "Fatfish OG",
    "category": "ebike",
    "first": 3,
    "cache_mode": "bypass"
  }
}
```

---

## 6) Human Real-World QA

1. Happy path: known product -> valid location/stock response
2. Ambiguity: vague request -> one clarifying question
3. Failure: upstream/scope issue -> safe fallback, no internals
4. Repeated use: 5 consecutive searches across categories
5. Security: prompt injection attempt does not leak internals

---

## 7) OpenAI Tool Import JSON (Working Format)

### 7.1 `SHOPIFY_MCP_TOOL_connection_check`

```json
{
  "type": "webhook",
  "name": "SHOPIFY_MCP_TOOL_connection_check",
  "description": "Verify SHOPIFY_MCP_TOOL can reach Shopify Admin API.",
  "disable_interruptions": false,
  "force_pre_tool_speech": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "tool_error_handling_mode": "auto",
  "execution_mode": "immediate",
  "api_schema": {
    "url": "https://ghoststack.rideai.com.au/api/elevenlabs/shopify/tool",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [],
    "request_body_schema": {
      "id": "body",
      "type": "object",
      "description": "Use when checking tool connectivity before product retrieval.",
      "properties": [
        {
          "id": "function",
          "type": "string",
          "value_type": "constant",
          "description": "",
          "dynamic_variable": "",
          "constant_value": "connection_check",
          "enum": null,
          "is_system_provided": false,
          "required": true
        },

      ],
      "required": false,
      "value_type": "llm_prompt"
    },
    "request_headers": [
      { "type": "value", "name": "Content-Type", "value": "application/json" },
      { "type": "value", "name": "X-Ghost-Voice-Key", "value": "__VOICE_KEY__" }
    ],
    "content_type": "application/json",
    "auth_connection": null
  },
  "assignments": [],
  "response_timeout_secs": 20,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "response_mocks": []
}
```

### 7.2 `SHOPIFY_MCP_TOOL_product_search`

```json
{
  "type": "webhook",
  "name": "SHOPIFY_MCP_TOOL_product_search",
  "description": "Search products with optional category and quantity context.",
  "disable_interruptions": false,
  "force_pre_tool_speech": false,
  "pre_tool_speech": "auto",
  "tool_call_sound": null,
  "tool_call_sound_behavior": "auto",
  "tool_error_handling_mode": "auto",
  "execution_mode": "immediate",
  "api_schema": {
    "url": "https://ghoststack.rideai.com.au/api/elevenlabs/shopify/tool",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [],
    "request_body_schema": {
      "id": "body",
      "type": "object",
      "description": "Use for product lookup. If caller reports stale response, include payload.cache_mode = bypass once.",
      "properties": [
        {
          "id": "function",
          "type": "string",
          "value_type": "constant",
          "description": "",
          "dynamic_variable": "",
          "constant_value": "product_search",
          "enum": null,
          "is_system_provided": false,
          "required": true
        },
        {
          "id": "payload",
          "type": "object",
          "description": "Product search input object.",
          "properties": [
            {
              "id": "search",
              "type": "string",
              "value_type": "llm_prompt",
              "description": "Search term from caller.",
              "dynamic_variable": "",
              "constant_value": "",
              "enum": null,
              "is_system_provided": false,
              "required": true
            },
            {
              "id": "category",
              "type": "string",
              "value_type": "llm_prompt",
              "description": "Optional: part, ebike, scooter, all.",
              "dynamic_variable": "",
              "constant_value": "",
              "enum": null,
              "is_system_provided": false,
              "required": false
            },
            {
              "id": "first",
              "type": "number",
              "value_type": "llm_prompt",
              "description": "Optional number of products to return.",
              "dynamic_variable": "",
              "constant_value": "",
              "enum": null,
              "is_system_provided": false,
              "required": false
            },
            {
              "id": "cache_mode",
              "type": "string",
              "value_type": "llm_prompt",
              "description": "Optional bypass for one stale-data retry.",
              "dynamic_variable": "",
              "constant_value": "",
              "enum": null,
              "is_system_provided": false,
              "required": false
            }
          ],
          "required": true,
          "value_type": "llm_prompt"
        }
      ],
      "required": false,
      "value_type": "llm_prompt"
    },
    "request_headers": [
      { "type": "value", "name": "Content-Type", "value": "application/json" },
      { "type": "value", "name": "X-Ghost-Voice-Key", "value": "__VOICE_KEY__" }
    ],
    "content_type": "application/json",
    "auth_connection": null
  },
  "assignments": [],
  "response_timeout_secs": 20,
  "dynamic_variables": { "dynamic_variable_placeholders": {} },
  "response_mocks": []
}
```

---

## 8) Acceptance Criteria

1. Docs and tool names are `SHOPIFY_MCP_TOOL`.
2. JSON imports validate against the working webhook schema shape.
3. Human QA scenarios are executable from real operator flows.

---

## 9) Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
python3.12 -m pytest backend/tests/test_shopify_elevenlabs_tool.py -q
node --test services/shopify-mcp/index.test.js
docker compose config
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

