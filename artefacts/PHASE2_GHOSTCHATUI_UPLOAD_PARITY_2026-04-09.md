# Phase 2 GhostChatUI Upload Parity

Date: 2026-04-09

## Goal

Treat `GhostDASH /chat` as the internal test harness only, while moving the conversation-upload workflow into `ghost_chatui` so the user-facing chat surface can attach files, keep them conversation-only, or promote them into durable knowledge.

## What Changed

### 1. GhostChatUI now exposes conversation uploads

Enabled the previously reserved `Attach` capability in `ghost_chatui`.

The product surface now supports:

- attach file from the main composer
- inspect conversation files from the right-side `Session Details` rail
- choose parse lane
- keep an upload chat-only
- request save-to-knowledge
- pick the target collection before confirming indexing

### 2. Upload state is now part of the GhostChatUI live session

Added live client support for:

- `GET /api/collections`
- `GET /api/conversations/{conversation_id}/uploads`
- `POST /api/conversations/{conversation_id}/uploads`
- `POST /api/chat/uploads/{upload_id}/decision`
- `POST /api/sync`

This keeps `ghost_chatui` using GhostDASH as the runtime owner instead of inventing a second upload or indexing path.

### 3. User guidance is explicit instead of hidden

When there is no server-side conversation yet, `ghost_chatui` now explains that the first message must be sent before files can be attached.

This avoids a silent disabled control and makes the product behavior match the underlying conversation model.

### 4. Backend upload staging bug fixed

Focused upload tests exposed a real defect in the conversation-upload route:

- `ChatUploadRecord.storage_path` was required by the ORM model
- the API inserted the upload row before the path had been generated
- this could fail at the first flush with `NOT NULL constraint failed: chat_uploads.storage_path`

Fixed by generating the upload id and destination path before the initial insert so the row is valid from the first database write.

### 5. Upload test harness repaired

Updated `tests/test_chat_uploads.py` to use the same SQLite `StaticPool` and `check_same_thread=False` pattern already required by the other FastAPI `TestClient` suites.

This keeps upload coverage stable instead of depending on thread-local in-memory SQLite behavior.

## Validation

### Automated

- Focused backend tests passed:
  - `tests/test_connections_and_bootstrap.py`
  - `tests/test_embedding_cache.py`
  - `tests/test_runtime_profiles.py`
  - `tests/test_chat_uploads.py`

### Deployment

- Rebuilt and restarted:
  - `ghost-chatui`
  - `control-api`

### Live checks

Verified locally after deploy:

- `GET /api/chat/bootstrap?surface=ghost_chatui`
- conversation creation through `/agent/chat/stream`
- upload staging through `/api/conversations/{conversation_id}/uploads`

Verified visible product controls in the browser:

- composer `Attach` button exists
- right rail `Conversation Files` section exists
- empty conversation guidance is visible before first upload

## Residual Issues

### 1. Save-to-knowledge still needs deliberate human confirmation

The product path is now wired, but promoting a real document into shared knowledge will create durable data and kick ingestion.

That should be human-validated with an intentional test document and target collection, not by spraying synthetic files into production collections automatically.

### 2. Chat-surface convergence is not complete yet

This slice ports a key user-facing feature out of the GhostDASH harness, but it does not yet finish the broader model-availability flow where saved GhostDASH LLM connections publish discovered models for agent config and GhostChatUI selection.

## Acceptance Criteria

- `GhostDASH /chat` can remain a harness without being the only place that supports conversation uploads.
- `ghost_chatui` exposes attach, upload status, and upload decision controls.
- live upload staging no longer fails because of `chat_uploads.storage_path` insertion order.
- focused upload/backend tests pass again.

## Exact Verify Commands

```bash
curl -sS http://localhost/api/chat/bootstrap?surface=ghost_chatui | jq '{surface,default_agent_id,features}'
AGENT_ID=$(curl -sS http://localhost/api/chat/bootstrap?surface=ghost_chatui | jq -r '.default_agent_id')
curl -sS -X POST http://localhost/agent/chat/stream \
  -H 'Content-Type: application/json' \
  -d "{\"message\":\"Upload verification setup\",\"agent_id\":\"$AGENT_ID\",\"api_mode\":\"responses\"}" >/tmp/ghostchatui-stream.txt
CONVO_ID=$(curl -sS http://localhost/api/agents/$AGENT_ID/conversations | jq -r '.[0].id')
curl -sS -X POST http://localhost/api/conversations/$CONVO_ID/uploads \
  -F agent_id=$AGENT_ID \
  -F policy_lane=default \
  -F "file=@-;filename=ghostchatui-upload-test.txt;type=text/plain" <<< 'ghost chatui upload verification'
docker run --rm -v /var/llamaindex/ghoststack-rag/backend:/app -w /app python:3.12-slim-bookworm bash -lc "pip install -q --upgrade pip setuptools wheel && pip install -q -e . pytest && pytest tests/test_connections_and_bootstrap.py tests/test_embedding_cache.py tests/test_runtime_profiles.py tests/test_chat_uploads.py"
```

### Human verification

1. Open `https://ghoststack.rideai.com.au/ghost_chatui`
2. Start a new conversation and confirm `Attach` is visible but disabled before the first message
3. Send the first message and confirm the right rail shows `Conversation Files`
4. Attach a small text or PDF file
5. Confirm the file appears in the rail with decision controls
6. Choose `Keep in this chat` and verify the status updates without forcing knowledge ingestion
7. Repeat with a non-production test document only if you want to validate `Save to knowledge`
