# Qdrant GPU Migration Artifact

## Scope

This artifact records the GPU enablement work for the GhostDASH vector store and the host-level prerequisite that had to be fixed before Docker GPU workloads could run.

## Changes Applied

- Updated [docker-compose.yml](../docker-compose.yml) so the `qdrant` service uses `qdrant/qdrant:gpu-nvidia-latest`.
- Enabled Docker GPU allocation for `qdrant` with `gpus: all`.
- Enabled Qdrant GPU indexing explicitly with `QDRANT__GPU__INDEXING`.
- Added optional `.env` knobs in [.env.example](../.env.example):
  - `QDRANT_GPU_INDEXING`
  - `QDRANT_GPU_DEVICE_FILTER`

## Host GPU Repair Performed

The host was not initially Docker-GPU ready because NVIDIA userspace and the loaded kernel module were mismatched:

- loaded kernel module: `590.48.01`
- installed userspace/NVML: `595.58.03`

Symptoms observed:

- `nvidia-smi` failed with `Driver/library version mismatch`
- `docker run --gpus all ...` failed with the same NVML mismatch

Repair performed on this non-production host:

1. Stop the GPU management processes holding `/dev/nvidia*`.
2. Unload `nvidia_uvm`, `nvidia_drm`, `nvidia_modeset`, `nvidia_fs`, `gdrdrv`, and `nvidia`.
3. Reload the NVIDIA modules from the installed `595.58.03` package.
4. Restart `nvidia-dcgm`.

After reload, both host and Docker GPU validation succeeded against the Tesla T4.

## Architecture Outcome

### What moved to GPU

- Qdrant indexing can now use the host GPU.
- This helps the vector-store side of heavy ingestion and segment/index build work.

### What did not move to GPU

- LLM generation still uses the configured provider API.
- Embeddings still use the configured provider API.
- `workflow-runtime` and `agent-ingress` remain CPU-side orchestration layers.

This means the change accelerates the vector database portion of the RAG stack, not end-to-end model inference.

## Why broader RAG GPU was not implemented here

The current repo architecture keeps model execution outside the host:

- [docs/ARCHITECTURE.md](./ARCHITECTURE.md) shows `workflow-runtime` calling the external provider and `LlamaParse`.
- [docker-compose.yml](../docker-compose.yml) sets `OPENAI_MODEL`, `OPENAI_EMBEDDING_MODEL`, and `OPENAI_BASE_URL` driven behavior instead of a local inference service.

Moving the broader RAG stack to GPU would therefore require an additional architecture change, such as:

- local embeddings first
- local embeddings plus local generation
- a local inference gateway with compatible APIs

That is a separate phase from enabling GPU-backed Qdrant.

## Risks

- If the host reboots back into an older NVIDIA kernel module, Docker GPU workloads will fail again until the driver state is reconciled.
- Qdrant GPU indexing improves vector-store work, but user-visible chat latency may still be dominated by remote provider response time.
- `workflow-runtime` still only waits for `qdrant` to be started, not fully ready.

## Acceptance Criteria

- Host `nvidia-smi` succeeds.
- Docker `--gpus all` containers succeed.
- Qdrant starts from the NVIDIA GPU image with GPU indexing enabled.
- Existing `qdrant_data` is preserved.
- Chat, streaming, and sync continue to function after the Qdrant image swap.

## Verification Performed

- Verified host GPU after driver reload with `nvidia-smi`.
- Verified Docker GPU passthrough with `nvidia/cuda:12.4.1-base-ubuntu22.04`.
- Updated compose and env scaffolding for GPU-backed Qdrant.

## Exact Verify Commands

```bash
cd /var/llamaindex/ghoststack-rag
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
docker compose config
docker compose up -d qdrant workflow-runtime control-api agent-ingress
docker logs --tail=120 ghoststack-rag-qdrant-1
curl -sS http://127.0.0.1/health
curl -sS -X POST http://127.0.0.1/agent/chat -H 'Content-Type: application/json' \
  -d '{"message":"Reply with exactly: ok","corpora":["default"],"api_mode":"chat_completions"}'
```

## Human Retest Request

Please verify from the dashboard:

- document/index views load without hanging
- chat opens and returns answers
- a sync over a corpus containing a large XLSX finishes without the previous Qdrant crash symptoms
