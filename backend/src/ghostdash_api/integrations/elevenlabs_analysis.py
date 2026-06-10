"""Operator-facing ElevenLabs analysis read APIs under /api."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import JSONResponse

from ghostdash_api.schemas import (
    ElevenLabsAnalysisAudioUnavailableView,
    ElevenLabsAnalysisConversationDetailView,
    ElevenLabsAnalysisConversationsListView,
    ElevenLabsAnalysisConversationSummaryView,
    ElevenLabsAnalysisTranscriptTurnView,
    ElevenLabsAnalysisTranscriptView,
)
from ghostdash_api.settings import get_settings

router = APIRouter(prefix="/api/elevenlabs/analysis", tags=["elevenlabs-analysis"])

_ELEVENLABS_API_BASE = "https://api.elevenlabs.io"

_VALID_CONVERSATION_STATUSES = ("initiated", "in-progress", "processing", "done", "failed")
_VALID_CALL_OUTCOMES = ("success", "failure", "unknown")


def _analysis_timeout_ms() -> int:
    settings = get_settings()
    configured = getattr(settings, "elevenlabs_analysis_timeout_ms", None)
    if configured is None:
        configured = getattr(settings, "shopify_mcp_timeout_ms", 15000)
    return int(configured or 15000)


def _build_headers() -> dict[str, str]:
    key = str(get_settings().elevenlabs_api_key or "").strip()
    if not key:
        raise HTTPException(503, "ElevenLabs API key is not configured.")
    return {"xi-api-key": key}


def _safe_error_detail(exc: HTTPException) -> tuple[str, str]:
    detail = exc.detail
    if isinstance(detail, dict):
        code = str(detail.get("code") or "elevenlabs_upstream_error")
        message = str(detail.get("message") or "ElevenLabs analysis is currently unavailable.")
        return code, message
    return "elevenlabs_upstream_error", str(detail or "ElevenLabs analysis is currently unavailable.")


def _base_filters(limit: int, cursor: str | None, search: str | None) -> list[tuple[str, str]]:
    params: list[tuple[str, str]] = [("page_size", str(limit))]
    if cursor:
        params.append(("cursor", cursor))
    if search:
        params.append(("search", search))
    return params


def _summary_from_item(item: dict[str, Any]) -> ElevenLabsAnalysisConversationSummaryView:
    return ElevenLabsAnalysisConversationSummaryView(
        id=str(item.get("conversation_id") or ""),
        title=item.get("call_summary_title"),
        started_at_unix_secs=item.get("start_time_unix_secs"),
        status=str(item.get("status") or "processing"),
        call_successful=str(item.get("call_successful") or "unknown"),
        duration_seconds=item.get("call_duration_secs"),
        message_count=item.get("message_count"),
        user_id=item.get("user_id"),
        branch_id=item.get("branch_id"),
        main_language=item.get("main_language"),
        channel=item.get("conversation_initiation_source"),
        direction=item.get("direction"),
        rating=item.get("rating"),
        agent_id=item.get("agent_id"),
        agent_name=item.get("agent_name"),
    )


def _detail_from_item(item: dict[str, Any]) -> ElevenLabsAnalysisConversationDetailView:
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    analysis = item.get("analysis") if isinstance(item.get("analysis"), dict) else {}
    charging = metadata.get("charging") if isinstance(metadata.get("charging"), dict) else {}
    return ElevenLabsAnalysisConversationDetailView(
        id=str(item.get("conversation_id") or ""),
        title=analysis.get("call_summary_title"),
        agent_id=item.get("agent_id"),
        agent_name=item.get("agent_name"),
        status=str(item.get("status") or "processing"),
        user_id=item.get("user_id"),
        branch_id=item.get("branch_id"),
        environment=item.get("environment"),
        text_only=bool(metadata.get("text_only", False)),
        started_at_unix_secs=metadata.get("start_time_unix_secs"),
        accepted_at_unix_secs=metadata.get("accepted_time_unix_secs"),
        duration_seconds=metadata.get("call_duration_secs"),
        cost=metadata.get("cost"),
        credits_llm=charging.get("llm_charge"),
        llm_cost=charging.get("llm_price"),
        call_successful=str(analysis.get("call_successful") or "unknown"),
        call_status=item.get("status"),
        call_summary_title=analysis.get("call_summary_title"),
        transcript_summary=analysis.get("transcript_summary"),
        termination_reason=metadata.get("termination_reason"),
        main_language=metadata.get("main_language"),
        has_audio=bool(item.get("has_audio", False)),
        has_user_audio=bool(item.get("has_user_audio", False)),
        has_response_audio=bool(item.get("has_response_audio", False)),
        visited_agents=[agent for agent in (item.get("visited_agents") or []) if isinstance(agent, dict)],
        tag_ids=[str(tag) for tag in (item.get("tag_ids") or [])],
        metadata=metadata,
        analysis=analysis,
        client_data=item.get("conversation_initiation_client_data")
        if isinstance(item.get("conversation_initiation_client_data"), dict)
        else {},
    )


def _transcript_from_item(conversation_id: str, transcript_rows: list[Any]) -> ElevenLabsAnalysisTranscriptView:
    turns: list[ElevenLabsAnalysisTranscriptTurnView] = []
    for idx, row in enumerate(transcript_rows):
        if not isinstance(row, dict):
            continue
        role = str(row.get("role") or "unknown")
        time_in_call = row.get("time_in_call_secs")
        turn = ElevenLabsAnalysisTranscriptTurnView(
            id=f"{conversation_id}:{idx}",
            role=role,
            start_time_seconds=time_in_call if isinstance(time_in_call, int) else None,
            message=row.get("message"),
            source_medium=row.get("source_medium"),
            interrupted=bool(row.get("interrupted", False)),
            metrics=row.get("conversation_turn_metrics") if isinstance(row.get("conversation_turn_metrics"), dict) else None,
            event_type="tool_call" if row.get("tool_calls") else None,
            agent_metadata=row.get("agent_metadata") if isinstance(row.get("agent_metadata"), dict) else {},
            tool_calls=[entry for entry in (row.get("tool_calls") or []) if isinstance(entry, dict)],
            tool_results=[entry for entry in (row.get("tool_results") or []) if isinstance(entry, dict)],
            llm_usage=row.get("llm_usage") if isinstance(row.get("llm_usage"), dict) else None,
        )
        turns.append(turn)
    return ElevenLabsAnalysisTranscriptView(conversation_id=conversation_id, turns=turns, turn_count=len(turns))


async def _fetch_json(path: str, params: list[tuple[str, str]] | None = None) -> dict[str, Any]:
    timeout_ms = _analysis_timeout_ms()
    timeout = max(2.0, float(timeout_ms) / 1000.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(f"{_ELEVENLABS_API_BASE}{path}", headers=_build_headers(), params=params)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            504,
            {"code": "elevenlabs_timeout", "message": "ElevenLabs request timed out. Please retry shortly."},
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            503,
            {"code": "elevenlabs_request_failed", "message": "Failed to reach ElevenLabs analysis service."},
        ) from exc
    if response.status_code == 404:
        raise HTTPException(404, {"code": "conversation_not_found", "message": "Conversation not found."})
    if response.status_code in {401, 403}:
        raise HTTPException(
            503,
            {
                "code": "elevenlabs_invalid_api_key",
                "message": "ElevenLabs API key is invalid or unauthorized for conversation analysis.",
            },
        )
    if response.status_code == 429:
        raise HTTPException(
            503,
            {
                "code": "elevenlabs_rate_limited",
                "message": "ElevenLabs rate limit reached. Please retry shortly.",
            },
        )
    if response.status_code >= 400:
        raise HTTPException(
            502,
            {"code": "elevenlabs_upstream_error", "message": "ElevenLabs returned an upstream error."},
        )
    payload = response.json() if response.content else {}
    if not isinstance(payload, dict):
        raise HTTPException(
            502,
            {"code": "elevenlabs_invalid_payload", "message": "Unexpected ElevenLabs response format."},
        )
    return payload


@router.get("/health")
async def elevenlabs_analysis_health() -> JSONResponse:
    timeout_ms = _analysis_timeout_ms()
    try:
        await _fetch_json("/v1/convai/conversations", params=[("page_size", "1")])
    except HTTPException as exc:
        code, message = _safe_error_detail(exc)
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "service": "elevenlabs-analysis",
                "ready": False,
                "error_code": code,
                "message": message,
                "timeout_ms": timeout_ms,
            },
        )
    return JSONResponse(
        status_code=200,
        content={
            "ok": True,
            "service": "elevenlabs-analysis",
            "ready": True,
            "message": "ElevenLabs analysis endpoint is reachable.",
            "timeout_ms": timeout_ms,
        },
    )


@router.get("/conversations", response_model=ElevenLabsAnalysisConversationsListView)
async def elevenlabs_analysis_conversations(
    limit: int = Query(default=30, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=512),
    search: str | None = Query(default=None, max_length=256),
    status: str | None = Query(default=None, description="Call outcome filter: success|failure|unknown"),
    conversation_status: str | None = Query(default=None, description="Conversation status: initiated|in-progress|processing|done|failed"),
    date_after_unix: int | None = Query(default=None, ge=0),
    date_before_unix: int | None = Query(default=None, ge=0),
    user_id: str | None = Query(default=None, max_length=128),
    branch_id: str | None = Query(default=None, max_length=128),
) -> ElevenLabsAnalysisConversationsListView:
    params = _base_filters(limit=limit, cursor=cursor, search=search)
    if status:
        normalized = status.strip().lower()
        if normalized not in _VALID_CALL_OUTCOMES:
            raise HTTPException(422, "status must be success, failure, or unknown.")
        params.append(("call_successful", normalized))
    if conversation_status:
        normalized_status = conversation_status.strip().lower()
        if normalized_status not in _VALID_CONVERSATION_STATUSES:
            raise HTTPException(422, "conversation_status must be initiated, in-progress, processing, done, or failed.")
        excluded = [item for item in _VALID_CONVERSATION_STATUSES if item != normalized_status]
        for item in excluded:
            params.append(("exclude_statuses", item))
    if date_after_unix is not None:
        params.append(("call_start_after_unix", str(date_after_unix)))
    if date_before_unix is not None:
        params.append(("call_start_before_unix", str(date_before_unix)))
    if user_id:
        params.append(("user_id", user_id.strip()))
    if branch_id:
        params.append(("branch_id", branch_id.strip()))
    try:
        payload = await _fetch_json("/v1/convai/conversations", params=params)
    except HTTPException as exc:
        if exc.status_code in {502, 503, 504}:
            code, message = _safe_error_detail(exc)
            return ElevenLabsAnalysisConversationsListView(
                items=[],
                next_cursor=None,
                has_more=False,
                upstream_ready=False,
                warning_code=code,
                warning_message=message,
                filters_applied={
                    "limit": limit,
                    "cursor": cursor,
                    "search": search,
                    "status": status,
                    "conversation_status": conversation_status,
                    "date_after_unix": date_after_unix,
                    "date_before_unix": date_before_unix,
                    "user_id": user_id,
                    "branch_id": branch_id,
                },
            )
        raise
    conversations = payload.get("conversations") if isinstance(payload.get("conversations"), list) else []
    items = [_summary_from_item(item) for item in conversations if isinstance(item, dict) and str(item.get("conversation_id") or "").strip()]
    return ElevenLabsAnalysisConversationsListView(
        items=items,
        next_cursor=payload.get("next_cursor"),
        has_more=bool(payload.get("has_more", False)),
        upstream_ready=True,
        filters_applied={
            "limit": limit,
            "cursor": cursor,
            "search": search,
            "status": status,
            "conversation_status": conversation_status,
            "date_after_unix": date_after_unix,
            "date_before_unix": date_before_unix,
            "user_id": user_id,
            "branch_id": branch_id,
        },
    )


@router.get("/conversations/{conversation_id}", response_model=ElevenLabsAnalysisConversationDetailView)
async def elevenlabs_analysis_conversation_detail(conversation_id: str) -> ElevenLabsAnalysisConversationDetailView:
    payload = await _fetch_json(f"/v1/convai/conversations/{conversation_id}")
    return _detail_from_item(payload)


@router.get("/conversations/{conversation_id}/transcript", response_model=ElevenLabsAnalysisTranscriptView)
async def elevenlabs_analysis_conversation_transcript(conversation_id: str) -> ElevenLabsAnalysisTranscriptView:
    payload = await _fetch_json(f"/v1/convai/conversations/{conversation_id}")
    transcript_rows = payload.get("transcript") if isinstance(payload.get("transcript"), list) else []
    return _transcript_from_item(conversation_id, transcript_rows)


@router.get("/conversations/{conversation_id}/audio", response_model=None)
async def elevenlabs_analysis_conversation_audio(conversation_id: str) -> Response:
    timeout_ms = _analysis_timeout_ms()
    timeout = max(4.0, float(timeout_ms) / 1000.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(
                f"{_ELEVENLABS_API_BASE}/v1/convai/conversations/{conversation_id}/audio",
                headers=_build_headers(),
            )
    except httpx.TimeoutException:
        unavailable = ElevenLabsAnalysisAudioUnavailableView(
            code="elevenlabs_audio_timeout",
            message="Audio retrieval timed out. Please try again.",
            retryable=True,
        )
        return JSONResponse(status_code=504, content=unavailable.model_dump())
    except httpx.RequestError:
        unavailable = ElevenLabsAnalysisAudioUnavailableView(
            code="elevenlabs_audio_request_failed",
            message="Audio retrieval failed before a response was received.",
            retryable=True,
        )
        return JSONResponse(status_code=503, content=unavailable.model_dump())

    if response.status_code == 404:
        unavailable = ElevenLabsAnalysisAudioUnavailableView(
            code="audio_unavailable",
            message="Audio is unavailable for this conversation.",
            retryable=False,
        )
        return JSONResponse(status_code=404, content=unavailable.model_dump())
    if response.status_code >= 400:
        unavailable = ElevenLabsAnalysisAudioUnavailableView(
            code="elevenlabs_audio_upstream_error",
            message="Audio is currently unavailable from ElevenLabs.",
            retryable=True,
        )
        return JSONResponse(status_code=502, content=unavailable.model_dump())
    if not response.content:
        unavailable = ElevenLabsAnalysisAudioUnavailableView(
            code="audio_empty_response",
            message="No audio payload was returned for this conversation.",
            retryable=False,
        )
        return JSONResponse(status_code=404, content=unavailable.model_dump())

    media_type = response.headers.get("content-type") or "audio/mpeg"
    return Response(
        content=response.content,
        media_type=media_type,
        headers={"Cache-Control": "no-store", "Content-Disposition": f'inline; filename="{conversation_id}.audio"'},
    )
