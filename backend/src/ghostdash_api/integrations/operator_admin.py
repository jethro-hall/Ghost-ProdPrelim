"""Operator admin authentication for Voice Ops mutating routes."""

from __future__ import annotations

import secrets

from fastapi import HTTPException, Request

from ghostdash_api.settings import get_settings

OPERATOR_ADMIN_HEADER = "X-Operator-Admin-Key"


def check_operator_admin_auth(request: Request) -> None:
    expected = str(get_settings().app_operator_admin_key or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail={"code": "operator_admin_not_configured", "message": "APP_OPERATOR_ADMIN_KEY is not configured."},
        )
    provided = str(request.headers.get(OPERATOR_ADMIN_HEADER) or "").strip()
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail={"code": "operator_admin_unauthorized", "message": "Unauthorized."})
