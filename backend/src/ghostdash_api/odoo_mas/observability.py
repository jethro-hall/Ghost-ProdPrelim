from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any


logger = logging.getLogger("ghostdash.odoo_mas")


def log_stage(stage: str, *, trace_id: str | None, status: str, payload: dict[str, Any] | None = None) -> None:
    body = {
        "service": "odoo_mas",
        "stage": stage,
        "trace_id": trace_id,
        "status": status,
        "ts": datetime.now(UTC).isoformat(),
        "payload": payload or {},
    }
    logger.info("odoo_mas_stage", extra={"event": body})
