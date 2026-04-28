from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from qdrant_client import QdrantClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import WorkflowRunEventRecord
from .settings import get_settings

settings = get_settings()


class MemoryService:
    def __init__(self) -> None:
        self._redis = self._build_redis_client()
        self._fallback_store: dict[str, tuple[dict[str, Any], datetime]] = {}
        self._qdrant = self._build_qdrant_client()

    def set_working_memory(self, key: str, value: dict[str, Any], *, ttl_seconds: int = 1800) -> None:
        payload = json.dumps(value)
        if self._redis is not None:
            self._redis.setex(key, ttl_seconds, payload)
            return
        expires_at = datetime.now(UTC) + timedelta(seconds=max(ttl_seconds, 1))
        self._fallback_store[key] = (value, expires_at)

    def get_working_memory(self, key: str) -> dict[str, Any] | None:
        if self._redis is not None:
            raw = self._redis.get(key)
            if not raw:
                return None
            return json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else str(raw))
        row = self._fallback_store.get(key)
        if row is None:
            return None
        value, expires_at = row
        if expires_at < datetime.now(UTC):
            self._fallback_store.pop(key, None)
            return None
        return value

    def build_episodic_snapshot(self, session: Session, run_id: str) -> list[dict[str, Any]]:
        events = list(
            session.scalars(
                select(WorkflowRunEventRecord)
                .where(WorkflowRunEventRecord.run_id == run_id)
                .order_by(WorkflowRunEventRecord.sequence.asc())
            )
        )
        return [
            {
                "sequence": event.sequence,
                "event_type": event.event_type,
                "task_key": event.task_key,
                "metadata": event.metadata_json or {},
                "created_at": event.created_at.isoformat(),
            }
            for event in events
        ]

    def promote_semantic_memory(
        self,
        *,
        run_id: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> str | None:
        content = str(content or "").strip()
        if not content or self._qdrant is None:
            return None
        point_id = str(uuid4())
        payload = {
            "run_id": run_id,
            "content": content[:12000],
            "metadata": metadata or {},
            "source": "workflow_run",
            "content_hash": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "created_at": datetime.now(UTC).isoformat(),
        }
        try:
            self._qdrant.upsert(
                collection_name=settings.app_qdrant_collection,
                points=[
                    {
                        "id": point_id,
                        # Semantic memory currently stores metadata only.
                        "vector": [0.0] * int(settings.app_qdrant_vector_size),
                        "payload": payload,
                    }
                ],
            )
            return point_id
        except Exception:
            return None

    @staticmethod
    def _build_redis_client():
        redis_url = str(getattr(settings, "app_redis_url", "") or "").strip()
        if not redis_url:
            return None
        try:
            import redis

            return redis.Redis.from_url(redis_url, decode_responses=False)
        except Exception:
            return None

    @staticmethod
    def _build_qdrant_client() -> QdrantClient | None:
        try:
            return QdrantClient(url=settings.app_qdrant_url, api_key=settings.qdrant_api_key or None)
        except Exception:
            return None


memory_service = MemoryService()

