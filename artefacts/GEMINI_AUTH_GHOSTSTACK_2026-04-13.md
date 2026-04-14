## Goal

Configure Google Gemini as an LLM provider in GhostStack / GhostDASH without accidentally sending requests to `www.google.com` or using the wrong auth header.

## What the `400` HTML means

If you see Google’s HTML error page:

- `400. That’s an error. Your client has issued a malformed or illegal request.`

…and the HTML contains `href=//www.google.com/`, then your client is **hitting `www.google.com`** (wrong host / wrong URL), not the Gemini API host.

## Gemini auth: which header?

There are **two different** Gemini surfaces with different auth expectations:

### A) Gemini API — OpenAI compatibility (recommended for GhostDASH)

- **Base URL**: `https://generativelanguage.googleapis.com/v1beta/openai`
- **Auth**: `Authorization: Bearer <GEMINI_API_KEY>`

This matches GhostDASH’s current LLM client approach (OpenAI-compatible client).

### B) Gemini API — native REST (not OpenAI compatible)

- **Base URL**: `https://generativelanguage.googleapis.com/v1beta`
- **Auth**: `x-goog-api-key: <GEMINI_API_KEY>`

GhostDASH now supports native Gemini `:generateContent` for provider kind `google_gemini` when the base URL is `.../v1beta` (not `.../v1beta/openai`).

### C) Vertex AI Gemini (GCP)

- **Base URL**: `https://<LOCATION>-aiplatform.googleapis.com/...`
- **Auth**: `Authorization: Bearer <OAuth2 access token>`

This is an access token (service account / `gcloud`), **not** an API key.

## How GhostDASH maps auth strategies today

GhostDASH supports:

- `bearer` → the OpenAI client library sends `Authorization: Bearer <api_key>`
- `x_api_key` → GhostDASH sends header `x-api-key: <api_key>`
- `x_goog_api_key` → GhostDASH sends header `x-goog-api-key: <api_key>` (Gemini native)
- `custom_header` → GhostDASH sends `<auth_header_name>: <api_key>`

So:

- For **OpenAI-compat Gemini**: use **`bearer`**
- For **native Gemini**: use **`x_goog_api_key`** (or `custom_header` with `x-goog-api-key`)

## Verification (no UI required)

If your stack is fronted by Caddy on host port 80, you can test the connection with:

```bash
curl -sS "http://localhost/api/connections/test" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "google-gemini",
    "label": "Google Gemini",
    "provider_kind": "google_gemini",
    "auth_strategy": "bearer",
    "api_key": "'"$GEMINI_API_KEY"'",
    "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
    "api_mode": "chat_completions",
    "prompt": "ping"
  }'
```

Acceptance signal: response includes `"ok": true`.

### Native Gemini verification (matches Google’s curl)

```bash
curl -sS "http://localhost/api/connections/test" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "google-gemini",
    "label": "Google Gemini",
    "provider_kind": "google_gemini",
    "auth_strategy": "x_goog_api_key",
    "api_key": "'"$GEMINI_API_KEY"'",
    "base_url": "https://generativelanguage.googleapis.com/v1beta",
    "api_mode": "chat_completions",
    "model_id": "gemini-flash-latest",
    "prompt": "ping"
  }'
```

