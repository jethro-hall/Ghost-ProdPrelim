"""ElevenLabs agent test workbench APIs (Phase 1: simulation runs)."""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from ghostdash_api.integrations import elevenlabs_simulations as sim_store
from ghostdash_api.settings import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/elevenlabs/tests", tags=["elevenlabs-tests"])

_ELEVENLABS_API_BASE = "https://api.elevenlabs.io"


class SimulationRunRequest(BaseModel):
    agent_id: str | None = Field(default=None, max_length=128)
    test_id: str | None = Field(default=None, max_length=256)
    user_scenario: str | None = Field(default=None, max_length=4000)
    success_criteria: str | None = Field(default=None, max_length=4000)
    max_turns: int = Field(default=5, ge=1, le=50)
    partial_history: list[dict[str, Any]] | None = Field(default=None, max_length=80)
    simulated_user_prompt: str | None = Field(default=None, max_length=12000)
    agent_prompt_override: str | None = Field(default=None, max_length=12000)
    agent_llm: str | None = Field(default=None, max_length=64)
    agent_temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    simulated_user_llm: str | None = Field(default=None, max_length=64)
    simulated_user_temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    dynamic_variables: dict[str, str] | None = None
    tool_mock_config: dict[str, Any] | None = None
    tool_execution_mode: str = Field(default="call_real_tools", max_length=32)
    selected_tool_ids: list[str] = Field(default_factory=list)
    agent_tool_ids_override: list[str] = Field(default_factory=list)
    tool_direction_prompt: str | None = Field(default=None, max_length=4000)
    extra_evaluation_criteria: list[dict[str, Any]] | None = None
    agent_config_override: dict[str, Any] | None = None
    conversation_config_override: dict[str, Any] | None = None
    simulation_specification_extra: dict[str, Any] | None = None
    elevenlabs_request_extra: dict[str, Any] | None = None
    simulation_environment: str | None = Field(default=None, max_length=64)
    evaluate: bool = True


class WorkbenchTurnInput(BaseModel):
    role: str = Field(min_length=1, max_length=16)
    message: str = Field(default="", max_length=8000)
    time_in_call_secs: int = Field(default=0, ge=0, le=86400)
    tool_calls: list[dict[str, Any]] | None = None
    tool_results: list[dict[str, Any]] | None = None
    llm_override: str | None = Field(default=None, max_length=12000)

    @field_validator("role")
    @classmethod
    def _normalize_role(cls, value: str) -> str:
        role = str(value or "").strip().lower()
        if role not in {"agent", "user"}:
            raise ValueError("role must be agent or user")
        return role


class StepConversationRequest(BaseModel):
    agent_id: str | None = Field(default=None, max_length=128)
    history: list[WorkbenchTurnInput] = Field(min_length=1, max_length=80)
    stop_index: int | None = Field(default=None, ge=0, le=79)
    step_mode: str = Field(default="agent", max_length=16)
    forced_user_message: str | None = Field(default=None, max_length=4000)
    simulated_user_prompt: str | None = Field(default=None, max_length=12000)
    simulated_user_llm: str | None = Field(default=None, max_length=64)
    simulated_user_temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    agent_prompt_override: str | None = Field(default=None, max_length=12000)
    agent_llm: str | None = Field(default=None, max_length=64)
    agent_temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    dynamic_variables: dict[str, str] | None = None
    tool_mock_config: dict[str, Any] | None = None
    tool_execution_mode: str = Field(default="call_real_tools", max_length=32)
    selected_tool_ids: list[str] = Field(default_factory=list)
    agent_tool_ids_override: list[str] = Field(default_factory=list)
    tool_direction_prompt: str | None = Field(default=None, max_length=4000)
    extra_evaluation_criteria: list[dict[str, Any]] | None = None
    agent_config_override: dict[str, Any] | None = None
    conversation_config_override: dict[str, Any] | None = None
    simulation_specification_extra: dict[str, Any] | None = None
    elevenlabs_request_extra: dict[str, Any] | None = None
    simulation_environment: str | None = Field(default=None, max_length=64)
    new_turns_limit: int | None = Field(default=None, ge=1, le=20)
    evaluate: bool = False
    success_criteria: str | None = Field(default=None, max_length=4000)
    expected_tool_name: str | None = Field(default=None, max_length=128)


def _test_timeout_seconds() -> float:
    settings = get_settings()
    configured = getattr(settings, "elevenlabs_test_timeout_ms", None) or getattr(settings, "elevenlabs_analysis_timeout_ms", 120000)
    return max(10.0, float(configured or 120000) / 1000.0)


def _build_headers() -> dict[str, str]:
    key = str(get_settings().elevenlabs_api_key or "").strip()
    if not key:
        raise HTTPException(
            status_code=503,
            detail={"code": "elevenlabs_not_configured", "message": "ElevenLabs API key is not configured."},
        )
    return {"xi-api-key": key, "Content-Type": "application/json"}


def _run_artifacts_dir() -> Path:
    settings = get_settings()
    data_dir = Path(str(getattr(settings, "app_data_dir", "") or "").strip() or "/data")
    candidates = [
        data_dir / "call-simulation-runs",
        data_dir / "artefacts" / "call-simulation-runs",
        Path("/app/artefacts/call-simulation-runs"),
        Path.cwd() / "artefacts" / "call-simulation-runs",
        Path(__file__).resolve().parents[4] / "artefacts" / "call-simulation-runs",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    chosen = candidates[0]
    chosen.mkdir(parents=True, exist_ok=True)
    return chosen


def _log_outbound(*, trace_id: str, route: str, start_ts: float, status: str, latency_ms: float, error: str | None = None) -> None:
    logger.info(
        json.dumps(
            {
                "trace_id": trace_id,
                "span_id": trace_id[:16],
                "service": "control-api",
                "route": route,
                "start_ts": start_ts,
                "end_ts": time.time(),
                "latency_ms": round(latency_ms, 3),
                "status": status,
                "error": error,
            }
        )
    )


def _deep_merge_dict(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in patch.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _deep_merge_dict(merged[key], value)
        else:
            merged[key] = value
    return merged


def _resolve_tool_mock_config(
    *,
    raw: dict[str, Any] | None,
    mode: str | None,
    selected_tool_ids: list[str] | None,
) -> dict[str, Any] | None:
    if raw:
        return raw
    # ElevenLabs currently 422s on string mocking_strategy/fallback_strategy in simulate-conversation.
    # Omit tool_mock_config so the platform default (live tools) applies unless advanced JSON supplies a valid shape.
    _ = mode, selected_tool_ids
    return None


def _extract_tool_summaries(payload: dict[str, Any]) -> list[dict[str, str]]:
    rows = payload.get("tools")
    if not isinstance(rows, list):
        return []
    summaries: list[dict[str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        tool_id = str(row.get("id") or row.get("tool_id") or "").strip()
        tool_config = row.get("tool_config") if isinstance(row.get("tool_config"), dict) else {}
        name = str(tool_config.get("name") or row.get("name") or tool_id).strip()
        tool_type = str(tool_config.get("type") or row.get("type") or "").strip()
        if tool_id or name:
            summaries.append({"id": tool_id, "name": name, "type": tool_type})
    return summaries


def _extract_agent_tool_ids(agent_payload: dict[str, Any]) -> list[str]:
    conversation = agent_payload.get("conversation_config") if isinstance(agent_payload.get("conversation_config"), dict) else {}
    agent = conversation.get("agent") if isinstance(conversation.get("agent"), dict) else {}
    prompt = agent.get("prompt") if isinstance(agent.get("prompt"), dict) else {}
    tool_ids = prompt.get("tool_ids")
    if not isinstance(tool_ids, list):
        return []
    return [str(item).strip() for item in tool_ids if str(item).strip()]


async def _fetch_json(
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    timeout = _test_timeout_seconds()
    headers = _build_headers()
    url = f"{_ELEVENLABS_API_BASE}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            if method.upper() == "GET":
                response = await client.get(url, headers=headers, params=params or None)
            else:
                response = await client.post(url, headers=headers, json=body or {}, params=params or None)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail={"code": "elevenlabs_timeout", "message": "ElevenLabs test request timed out. Please retry shortly."},
        ) from exc
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "elevenlabs_request_failed", "message": "Failed to reach ElevenLabs test service."},
        ) from exc

    if response.status_code in {401, 403}:
        raise HTTPException(
            status_code=503,
            detail={"code": "elevenlabs_invalid_api_key", "message": "ElevenLabs API key is invalid or unauthorized."},
        )
    if response.status_code == 429:
        raise HTTPException(
            status_code=503,
            detail={"code": "elevenlabs_rate_limited", "message": "ElevenLabs rate limit reached. Please retry shortly."},
        )
    if response.status_code >= 400:
        message = "ElevenLabs returned an upstream error."
        try:
            payload = response.json()
            if isinstance(payload, dict):
                detail = payload.get("detail")
                if isinstance(detail, dict):
                    message = str(detail.get("message") or message)
                elif isinstance(detail, str):
                    message = detail
                elif isinstance(detail, list):
                    parts: list[str] = []
                    for item in detail[:6]:
                        if isinstance(item, dict):
                            loc = ".".join(str(part) for part in (item.get("loc") or []))
                            msg = str(item.get("msg") or "").strip()
                            if loc and msg:
                                parts.append(f"{loc}: {msg}")
                            elif msg:
                                parts.append(msg)
                    if parts:
                        message = "; ".join(parts)
        except Exception:
            pass
        raise HTTPException(status_code=502, detail={"code": "elevenlabs_upstream_error", "message": message})

    payload = response.json() if response.content else {}
    if not isinstance(payload, dict):
        raise HTTPException(status_code=502, detail={"code": "elevenlabs_invalid_payload", "message": "Unexpected ElevenLabs response format."})
    return payload


async def _resolve_agent_id(*, simulation: dict[str, Any], requested_agent_id: str | None) -> str:
    if requested_agent_id and requested_agent_id.strip():
        return requested_agent_id.strip()

    settings = get_settings()
    configured = str(getattr(settings, "elevenlabs_convai_agent_id", "") or "").strip()
    if configured:
        return configured

    conversation = simulation.get("conversation") if isinstance(simulation.get("conversation"), dict) else {}
    conversation_id = str(conversation.get("id") or "").strip()
    if conversation_id:
        detail = await _fetch_json("GET", f"/v1/convai/conversations/{conversation_id}")
        agent_id = str(detail.get("agent_id") or "").strip()
        if agent_id:
            return agent_id

    raise HTTPException(
        status_code=422,
        detail={
            "code": "agent_id_required",
            "message": "Provide agent_id in the run request or configure ELEVENLABS_CONVAI_AGENT_ID.",
        },
    )


def _select_repeatable_test(simulation: dict[str, Any], test_id: str | None) -> dict[str, Any] | None:
    tests = simulation.get("repeatable_real_world_tests")
    if not isinstance(tests, list):
        return None
    normalized = [entry for entry in tests if isinstance(entry, dict)]
    if not normalized:
        return None
    if test_id:
        for entry in normalized:
            if str(entry.get("id") or "").strip() == test_id.strip():
                return entry
        return None
    return normalized[0]


def _build_user_scenario(simulation: dict[str, Any], test: dict[str, Any] | None, override: str | None) -> str:
    if override and override.strip():
        return override.strip()

    if test:
        objective = str(test.get("objective") or "").strip()
        steps = test.get("steps") if isinstance(test.get("steps"), list) else []
        step_lines = []
        for step in steps:
            if not isinstance(step, dict):
                continue
            action = str(step.get("action") or "").strip()
            if action:
                step_lines.append(action)
        if objective and step_lines:
            return f"{objective}\n" + "\n".join(step_lines)
        if objective:
            return objective
        if step_lines:
            return "\n".join(step_lines)

    conversation = simulation.get("conversation") if isinstance(simulation.get("conversation"), dict) else {}
    brief = str(conversation.get("brief_summary") or "").strip()
    if brief:
        return f"Replay this real customer call scenario: {brief}"

    return "Simulate a realistic customer calling Ride Electric about their bike or scooter service request."


def _build_success_criteria(test: dict[str, Any] | None, override: str | None) -> str:
    if override and override.strip():
        return override.strip()
    if not test:
        return "The agent provides a clear, customer-safe next step without internal diagnostics."
    assertions = test.get("assertions") if isinstance(test.get("assertions"), list) else []
    cleaned = [str(item).strip() for item in assertions if str(item).strip()]
    if cleaned:
        return " ".join(cleaned)
    return str(test.get("objective") or "The agent completes the caller request appropriately.").strip()


def _format_partial_history_row(turn: WorkbenchTurnInput | dict[str, Any], *, index: int) -> dict[str, Any]:
    if isinstance(turn, WorkbenchTurnInput):
        role = turn.role
        message = turn.message
        at_secs = turn.time_in_call_secs
        tool_calls = turn.tool_calls
        tool_results = turn.tool_results
        llm_override = turn.llm_override
    else:
        role = str(turn.get("role") or "").strip().lower()
        message = str(turn.get("message") or "")
        at_secs = int(turn.get("time_in_call_secs") or index * 3)
        tool_calls = turn.get("tool_calls") if isinstance(turn.get("tool_calls"), list) else []
        tool_results = turn.get("tool_results") if isinstance(turn.get("tool_results"), list) else []
        llm_override = str(turn.get("llm_override") or "").strip() or None

    # ElevenLabs simulate only accepts role/message/time (and optional llm_override).
    # Playback tool_calls lack required request_id and cause 422 if forwarded verbatim.
    row: dict[str, Any] = {
        "role": role,
        "message": message,
        "time_in_call_secs": max(0, at_secs if at_secs else index * 3),
    }
    if llm_override:
        row["llm_override"] = llm_override[:12000]
    return row


def _build_simulated_user_prompt(
    *,
    simulation: dict[str, Any] | None,
    test: dict[str, Any] | None,
    user_scenario: str | None,
    partial_rows: list[dict[str, Any]] | None = None,
) -> str:
    scenario = _build_user_scenario(simulation or {}, test, user_scenario) if simulation else (user_scenario or "").strip()
    if not scenario:
        scenario = "Continue the conversation naturally as the customer."

    if not partial_rows:
        if simulation:
            strict_payload = sim_store._strict_elevenlabs_test_payload(simulation)
            history = strict_payload.get("chat_history") if isinstance(strict_payload.get("chat_history"), list) else []
            context_lines: list[str] = []
            for turn in history[:8]:
                if not isinstance(turn, dict):
                    continue
                role = str(turn.get("role") or "").strip()
                message = str(turn.get("message") or "").strip()
                if role and message:
                    context_lines.append(f"{role}: {message}")
            context_block = "\n".join(context_lines)
            if context_block:
                return f"{scenario}\n\nRecorded call context:\n{context_block}"
        return scenario[:12000]

    context_lines = []
    for turn in partial_rows[-8:]:
        role = str(turn.get("role") or "").strip()
        message = str(turn.get("message") or "").strip()
        if role and message:
            context_lines.append(f"{role}: {message}")
    context_block = "\n".join(context_lines)
    if context_block:
        return f"{scenario}\n\nConversation so far:\n{context_block}"[:12000]
    return scenario[:12000]


def _apply_prompt_overrides(
    simulation_spec: dict[str, Any],
    *,
    simulated_user_prompt: str | None,
    simulated_user_llm: str | None,
    simulated_user_temperature: float | None,
    agent_prompt_override: str | None,
    agent_llm: str | None,
    agent_temperature: float | None,
) -> None:
    if simulated_user_prompt or simulated_user_llm or simulated_user_temperature is not None:
        simulated_cfg = simulation_spec.setdefault(
            "simulated_user_config",
            {"prompt": {"prompt": "", "llm": "gpt-4o-mini", "temperature": 0.4}},
        )
        prompt_cfg = simulated_cfg.setdefault("prompt", {})
        if simulated_user_prompt:
            prompt_cfg["prompt"] = simulated_user_prompt[:12000]
        if simulated_user_llm:
            prompt_cfg["llm"] = simulated_user_llm
        if simulated_user_temperature is not None:
            prompt_cfg["temperature"] = simulated_user_temperature

    if agent_prompt_override or agent_llm or agent_temperature is not None:
        override = simulation_spec.setdefault("conversation_config_override", {})
        agent_cfg = override.setdefault("agent", {})
        prompt_cfg = agent_cfg.setdefault("prompt", {})
        if agent_prompt_override:
            prompt_cfg["prompt"] = agent_prompt_override[:12000]
        if agent_llm:
            prompt_cfg["llm"] = agent_llm
        if agent_temperature is not None:
            prompt_cfg["temperature"] = agent_temperature


def _build_simulate_request_body(
    *,
    simulation: dict[str, Any] | None,
    test: dict[str, Any] | None,
    body: SimulationRunRequest | StepConversationRequest,
    partial_rows: list[dict[str, Any]] | None = None,
    include_evaluation: bool | None = None,
) -> dict[str, Any]:
    criteria = _build_success_criteria(test, getattr(body, "success_criteria", None))
    user_scenario = getattr(body, "user_scenario", None)
    prompt = body.simulated_user_prompt or _build_simulated_user_prompt(
        simulation=simulation,
        test=test,
        user_scenario=user_scenario,
        partial_rows=partial_rows,
    )

    simulation_spec: dict[str, Any] = {
        "simulated_user_config": {
            "prompt": {
                "prompt": prompt[:12000],
                "llm": body.simulated_user_llm or "gpt-4o-mini",
                "temperature": body.simulated_user_temperature if body.simulated_user_temperature is not None else 0.4,
            }
        }
    }
    if partial_rows:
        simulation_spec["partial_conversation_history"] = partial_rows
    elif getattr(body, "partial_history", None):
        simulation_spec["partial_conversation_history"] = body.partial_history[:80]

    if body.dynamic_variables:
        simulation_spec["dynamic_variables"] = body.dynamic_variables

    tool_mock_config = _resolve_tool_mock_config(
        raw=body.tool_mock_config,
        mode=body.tool_execution_mode,
        selected_tool_ids=body.selected_tool_ids,
    )
    if tool_mock_config:
        simulation_spec["tool_mock_config"] = tool_mock_config

    tool_direction = str(getattr(body, "tool_direction_prompt", "") or "").strip()
    agent_prompt_override = body.agent_prompt_override
    if tool_direction:
        agent_prompt_override = "\n\n".join(
            [part for part in [str(agent_prompt_override or "").strip(), tool_direction] if part]
        ).strip()

    _apply_prompt_overrides(
        simulation_spec,
        simulated_user_prompt=body.simulated_user_prompt,
        simulated_user_llm=body.simulated_user_llm,
        simulated_user_temperature=body.simulated_user_temperature,
        agent_prompt_override=agent_prompt_override,
        agent_llm=body.agent_llm,
        agent_temperature=body.agent_temperature,
    )

    if body.conversation_config_override:
        simulation_spec["conversation_config_override"] = _deep_merge_dict(
            simulation_spec.get("conversation_config_override") if isinstance(simulation_spec.get("conversation_config_override"), dict) else {},
            body.conversation_config_override,
        )

    if body.agent_tool_ids_override:
        override = simulation_spec.setdefault("conversation_config_override", {})
        agent = override.setdefault("agent", {})
        prompt_cfg = agent.setdefault("prompt", {})
        existing_ids = prompt_cfg.get("tool_ids") if isinstance(prompt_cfg.get("tool_ids"), list) else []
        prompt_cfg["tool_ids"] = list(
            dict.fromkeys([str(item).strip() for item in existing_ids if str(item).strip()] + body.agent_tool_ids_override)
        )

    if body.simulation_specification_extra:
        simulation_spec = _deep_merge_dict(simulation_spec, body.simulation_specification_extra)

    should_evaluate = include_evaluation if include_evaluation is not None else bool(getattr(body, "evaluate", True))
    evaluation_rows: list[dict[str, Any]] = []
    if should_evaluate:
        if body.extra_evaluation_criteria:
            evaluation_rows = list(body.extra_evaluation_criteria)
        else:
            evaluation_rows = [
                {
                    "id": "ghostdash_success_criteria",
                    "name": "GhostDASH success criteria",
                    "conversation_goal_prompt": criteria[:4000],
                    "use_knowledge_base": False,
                }
            ]

    max_turns = getattr(body, "max_turns", None)
    if max_turns is None:
        max_turns = getattr(body, "new_turns_limit", 1) or 1

    payload: dict[str, Any] = {
        "simulation_specification": simulation_spec,
        "extra_evaluation_criteria": evaluation_rows,
        "new_turns_limit": max_turns,
    }
    if body.agent_config_override:
        payload["agent_config_override"] = body.agent_config_override
    if body.elevenlabs_request_extra:
        payload = _deep_merge_dict(payload, body.elevenlabs_request_extra)
    return payload


def _build_step_partial_history(body: StepConversationRequest) -> tuple[list[dict[str, Any]], int]:
    history = body.history
    stop_index = body.stop_index if body.stop_index is not None else len(history) - 1
    stop_index = max(0, min(stop_index, len(history) - 1))
    partial_inputs = history[: stop_index + 1]
    if body.forced_user_message is not None:
        forced = body.forced_user_message.strip()
        if partial_inputs and partial_inputs[-1].role == "user":
            partial_inputs[-1] = partial_inputs[-1].model_copy(update={"message": forced})
        else:
            last_at = partial_inputs[-1].time_in_call_secs if partial_inputs else 0
            partial_inputs.append(
                WorkbenchTurnInput(role="user", message=forced, time_in_call_secs=last_at + 3),
            )
    partial_rows = [_format_partial_history_row(turn, index=idx) for idx, turn in enumerate(partial_inputs)]
    return partial_rows, stop_index


def _step_to_run_request(body: StepConversationRequest, *, max_turns: int) -> SimulationRunRequest:
    return SimulationRunRequest(
        agent_id=body.agent_id,
        user_scenario=body.simulated_user_prompt,
        success_criteria=body.success_criteria,
        max_turns=max_turns,
        simulated_user_prompt=body.simulated_user_prompt,
        agent_prompt_override=body.agent_prompt_override,
        agent_llm=body.agent_llm,
        agent_temperature=body.agent_temperature,
        simulated_user_llm=body.simulated_user_llm,
        simulated_user_temperature=body.simulated_user_temperature,
        dynamic_variables=body.dynamic_variables,
        tool_mock_config=body.tool_mock_config,
        tool_execution_mode=body.tool_execution_mode,
        selected_tool_ids=body.selected_tool_ids,
        agent_tool_ids_override=body.agent_tool_ids_override,
        tool_direction_prompt=body.tool_direction_prompt,
        extra_evaluation_criteria=body.extra_evaluation_criteria,
        agent_config_override=body.agent_config_override,
        conversation_config_override=body.conversation_config_override,
        simulation_specification_extra=body.simulation_specification_extra,
        elevenlabs_request_extra=body.elevenlabs_request_extra,
        simulation_environment=body.simulation_environment,
        evaluate=body.evaluate,
    )


def _default_new_turns_for_step(step_mode: str) -> int:
    normalized = str(step_mode or "agent").strip().lower()
    if normalized == "both":
        return 2
    return 1


def _normalize_rich_turns(rows: list[Any]) -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        role = str(row.get("role") or "").strip()
        message = str(row.get("message") or "").strip()
        metrics = row.get("conversation_turn_metrics") if isinstance(row.get("conversation_turn_metrics"), dict) else {}
        llm_usage = row.get("llm_usage") if isinstance(row.get("llm_usage"), dict) else {}
        tool_calls = row.get("tool_calls") if isinstance(row.get("tool_calls"), list) else []
        tool_results = row.get("tool_results") if isinstance(row.get("tool_results"), list) else []
        latency_ms = None
        for tool_result in tool_results:
            if not isinstance(tool_result, dict):
                continue
            raw_latency = tool_result.get("tool_latency_secs")
            if isinstance(raw_latency, (int, float)):
                latency_ms = round(float(raw_latency) * 1000, 2)
                break
        if latency_ms is None and isinstance(metrics, dict):
            for key in ("total_ms", "latency_ms", "tts_ms"):
                raw = metrics.get(key)
                if isinstance(raw, (int, float)):
                    latency_ms = float(raw)
                    break

        summary.append(
            {
                "role": role,
                "message": message[:8000],
                "tool_calls": tool_calls[:20],
                "tool_results": tool_results[:20],
                "latency_ms": latency_ms,
                "llm_usage": llm_usage,
                "metrics": metrics,
                "llm_override": row.get("llm_override"),
            }
        )
    return summary[:80]


def _tool_invocation_check(turns: list[dict[str, Any]], expected_tool_name: str | None, pass_if_any: bool) -> dict[str, Any]:
    expected = str(expected_tool_name or "").strip()
    observed: list[str] = []
    for turn in turns:
        for call in turn.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            name = str(call.get("tool_name") or "").strip()
            if name:
                observed.append(name)
    if not expected:
        passed = len(observed) == 0
        return {
            "passed": passed,
            "expected_tool_name": "",
            "observed_tool_names": observed,
            "message": "No tool call observed." if passed else f"Unexpected tools: {', '.join(observed)}",
        }
    if pass_if_any:
        passed = expected in observed
    else:
        passed = observed == [expected] if observed else False
    return {
        "passed": passed,
        "expected_tool_name": expected,
        "observed_tool_names": observed,
        "message": "Expected tool invoked." if passed else f"Expected {expected}; saw {', '.join(observed) or 'none'}",
    }


def _normalize_run_status(analysis: dict[str, Any]) -> str:
    outcome = str(analysis.get("call_successful") or "").strip().lower()
    if outcome == "success":
        return "passed"
    if outcome == "failure":
        return "failed"
    return "completed"


def _summarize_conversation_turns(rows: list[Any], *, rich: bool = False) -> list[dict[str, Any]]:
    if rich:
        return _normalize_rich_turns(rows)
    summary: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        role = str(row.get("role") or "").strip()
        message = str(row.get("message") or "").strip()
        if role:
            summary.append({"role": role, "message": message[:500]})
    return summary[:40]


async def _execute_simulate(
    *,
    agent_id: str,
    request_body: dict[str, Any],
    trace_id: str,
    route: str,
    started: float,
    meta: dict[str, Any],
) -> JSONResponse:
    try:
        upstream = await _fetch_json(
            "POST",
            f"/v1/convai/agents/{agent_id}/simulate-conversation",
            body=request_body,
        )
        analysis = upstream.get("analysis") if isinstance(upstream.get("analysis"), dict) else {}
        simulated = upstream.get("simulated_conversation") if isinstance(upstream.get("simulated_conversation"), list) else []
        status = _normalize_run_status(analysis)
        latency_ms = round((time.time() - started) * 1000, 3)
        run_id = f"simrun_{int(time.time())}_{uuid.uuid4().hex[:8]}"

        rich_turns = _normalize_rich_turns(simulated)
        partial_count = int(meta.get("partial_turn_count") or 0)
        if partial_count > 0 and len(rich_turns) > partial_count:
            delta_turns = rich_turns[partial_count:]
            merged_turns = rich_turns
        else:
            delta_turns = rich_turns
            merged_turns = rich_turns
        result = {
            "run_id": run_id,
            "trace_id": trace_id,
            "status": status,
            "latency_ms": latency_ms,
            "agent_id": agent_id,
            "upstream_endpoint": f"/v1/convai/agents/{agent_id}/simulate-conversation",
            "elevenlabs_request": request_body,
            "started_at": datetime.now(UTC).isoformat(),
            "call_successful": analysis.get("call_successful"),
            "transcript_summary": analysis.get("transcript_summary"),
            "call_summary_title": analysis.get("call_summary_title"),
            "evaluation_criteria_results": analysis.get("evaluation_criteria_results"),
            "turns": merged_turns,
            "new_turns": delta_turns,
            "turn_count": len(merged_turns),
            "message": "Simulation step completed.",
            **meta,
        }

        artifact_path = _persist_run_artifact({**result, "request": request_body, "upstream": upstream})
        result["artifact_path"] = artifact_path

        _log_outbound(trace_id=trace_id, route=route, start_ts=started, status="200", latency_ms=latency_ms)
        return JSONResponse(status_code=200, content=result)
    except HTTPException as exc:
        latency_ms = round((time.time() - started) * 1000, 3)
        detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
        _log_outbound(
            trace_id=trace_id,
            route=route,
            start_ts=started,
            status=str(exc.status_code),
            latency_ms=latency_ms,
            error=str(detail.get("message") or detail),
        )
        safe = {
            "run_id": None,
            "trace_id": trace_id,
            "status": "error",
            "latency_ms": latency_ms,
            "message": str(detail.get("message") or "Simulation step failed."),
            "error_code": str(detail.get("code") or "simulation_step_failed"),
            **meta,
        }
        return JSONResponse(status_code=exc.status_code, content=safe)
    except Exception as exc:
        latency_ms = round((time.time() - started) * 1000, 3)
        _log_outbound(trace_id=trace_id, route=route, start_ts=started, status="500", latency_ms=latency_ms, error=str(exc))
        return JSONResponse(
            status_code=500,
            content={
                "run_id": None,
                "trace_id": trace_id,
                "status": "error",
                "latency_ms": latency_ms,
                "message": "Simulation step failed. Please retry shortly.",
                "error_code": "simulation_step_failed",
                **meta,
            },
        )


def _persist_run_artifact(payload: dict[str, Any]) -> str:
    root = _run_artifacts_dir()
    root.mkdir(parents=True, exist_ok=True)
    run_id = str(payload.get("run_id") or uuid.uuid4().hex)
    path = root / f"{run_id}.json"
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return str(path)


@router.get("/options")
async def elevenlabs_workbench_options() -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={
            "upstream": "elevenlabs_simulate_conversation",
            "endpoint_template": "/v1/convai/agents/{agent_id}/simulate-conversation",
            "description": "Every step and full run POST the same ElevenLabs simulate-conversation API with partial_conversation_history.",
            "tool_execution_modes": [
                {
                    "id": "call_real_tools",
                    "label": "Real ElevenLabs tools (live tool routing)",
                    "tool_mock_config": {"mocking_strategy": "none", "fallback_strategy": "call_real_tool"},
                },
                {
                    "id": "mock_selected",
                    "label": "Mock only selected tool IDs",
                    "tool_mock_config": {"mocking_strategy": "selected", "fallback_strategy": "call_real_tool"},
                },
                {
                    "id": "mock_all",
                    "label": "Mock all tools",
                    "tool_mock_config": {"mocking_strategy": "all", "fallback_strategy": "raise_error"},
                },
            ],
            "simulation_specification_fields": [
                "partial_conversation_history",
                "simulated_user_config",
                "conversation_config_override",
                "dynamic_variables",
                "tool_mock_config",
            ],
            "request_top_level_fields": [
                "simulation_specification",
                "extra_evaluation_criteria",
                "new_turns_limit",
                "agent_config_override",
            ],
            "llm_models": [
                "gpt-4o",
                "gpt-4o-mini",
                "gpt-4.1",
                "gpt-4.1-mini",
                "claude-sonnet-4",
                "claude-sonnet-4.5",
                "gemini-2.0-flash",
            ],
            "step_modes": ["agent", "user", "both"],
        },
    )


@router.get("/tools")
async def list_elevenlabs_workspace_tools(
    search: str | None = Query(default=None, max_length=120),
    page_size: int = Query(default=100, ge=1, le=100),
) -> JSONResponse:
    params: dict[str, Any] = {"page_size": page_size}
    if search and search.strip():
        params["search"] = search.strip()
    payload = await _fetch_json("GET", "/v1/convai/tools", params=params)
    tools = _extract_tool_summaries(payload)
    return JSONResponse(status_code=200, content={"tools": tools, "count": len(tools), "has_more": bool(payload.get("has_more"))})


@router.get("/agents/{agent_id}")
async def get_elevenlabs_agent_for_workbench(agent_id: str) -> JSONResponse:
    agent_id = str(agent_id or "").strip()
    if not agent_id:
        raise HTTPException(status_code=400, detail="agent_id is required.")
    payload = await _fetch_json("GET", f"/v1/convai/agents/{agent_id}")
    conversation = payload.get("conversation_config") if isinstance(payload.get("conversation_config"), dict) else {}
    agent = conversation.get("agent") if isinstance(conversation.get("agent"), dict) else {}
    prompt = agent.get("prompt") if isinstance(agent.get("prompt"), dict) else {}
    tts = conversation.get("tts") if isinstance(conversation.get("tts"), dict) else {}
    return JSONResponse(
        status_code=200,
        content={
            "agent_id": agent_id,
            "name": str(payload.get("name") or ""),
            "voice_id": str(tts.get("voice_id") or "").strip() or None,
            "tool_ids": _extract_agent_tool_ids(payload),
            "agent_prompt_excerpt": str(prompt.get("prompt") or "")[:2000],
            "agent_llm": str(prompt.get("llm") or ""),
            "agent_temperature": prompt.get("temperature"),
            "conversation_config": conversation,
        },
    )


@router.get("/health")
async def elevenlabs_tests_health() -> JSONResponse:
    settings = get_settings()
    configured = bool(str(settings.elevenlabs_api_key or "").strip())
    return JSONResponse(
        status_code=200 if configured else 503,
        content={
            "ok": configured,
            "service": "elevenlabs-tests",
            "ready": configured,
            "message": "ElevenLabs test runner is configured." if configured else "Configure ELEVENLABS_API_KEY to run simulations.",
            "timeout_ms": int(_test_timeout_seconds() * 1000),
        },
    )


@router.get("/simulations")
async def list_test_simulations(
    limit: int = Query(default=250, ge=1, le=1000),
    search: str | None = Query(default=None, max_length=120),
) -> JSONResponse:
    return await sim_store.list_simulation_packs(limit=limit, search=search)


@router.get("/simulations/{file_name}")
async def get_test_simulation(file_name: str) -> JSONResponse:
    response = await sim_store.get_simulation_pack(file_name)
    body = json.loads(response.body.decode("utf-8"))
    simulation = body.get("simulation") if isinstance(body.get("simulation"), dict) else {}
    tests = simulation.get("repeatable_real_world_tests")
    test_summaries: list[dict[str, Any]] = []
    if isinstance(tests, list):
        for entry in tests:
            if not isinstance(entry, dict):
                continue
            steps = entry.get("steps") if isinstance(entry.get("steps"), list) else []
            assertions = entry.get("assertions") if isinstance(entry.get("assertions"), list) else []
            test_summaries.append(
                {
                    "id": str(entry.get("id") or ""),
                    "name": str(entry.get("name") or ""),
                    "objective": str(entry.get("objective") or ""),
                    "step_count": len(steps),
                    "assertion_count": len(assertions),
                }
            )
    body["tests"] = test_summaries
    body["execution"] = {
        "next_reply": {"runnable": True, "phase": 2},
        "tool_invocation": {"runnable": True, "phase": 2},
        "simulation": {"runnable": True, "phase": 2},
        "step_debugger": {"runnable": True, "phase": 2},
    }
    return JSONResponse(status_code=200, content=body)


@router.post("/simulations/{file_name}/run")
async def run_test_simulation(file_name: str, body: SimulationRunRequest) -> JSONResponse:
    if not sim_store._FILENAME_RE.match(file_name):
        raise HTTPException(status_code=400, detail="Invalid simulation file name.")

    trace_id = uuid.uuid4().hex
    route = f"/api/elevenlabs/tests/simulations/{file_name}/run"
    started = time.time()

    path = sim_store._simulations_dir() / file_name
    simulation = sim_store._load_json_file(path)
    test = _select_repeatable_test(simulation, body.test_id)
    if body.test_id and test is None:
        raise HTTPException(status_code=404, detail="Requested test_id was not found in this simulation file.")

    agent_id = await _resolve_agent_id(simulation=simulation, requested_agent_id=body.agent_id)
    partial_rows = None
    if body.partial_history:
        partial_rows = body.partial_history[:80]
    request_body = _build_simulate_request_body(
        simulation=simulation,
        test=test,
        body=body,
        partial_rows=partial_rows,
        include_evaluation=body.evaluate,
    )
    partial_count = 0
    if partial_rows:
        partial_count = len(partial_rows)
    elif body.partial_history:
        partial_count = len(body.partial_history)

    return await _execute_simulate(
        agent_id=agent_id,
        request_body=request_body,
        trace_id=trace_id,
        route=route,
        started=started,
        meta={
            "file_name": file_name,
            "test_id": str((test or {}).get("id") or ""),
            "test_name": str((test or {}).get("name") or ""),
            "step_mode": "full",
            "partial_turn_count": partial_count,
        },
    )


@router.post("/step")
async def step_test_conversation(body: StepConversationRequest) -> JSONResponse:
    trace_id = uuid.uuid4().hex
    route = "/api/elevenlabs/tests/step"
    started = time.time()

    step_mode = str(body.step_mode or "agent").strip().lower()
    if step_mode not in {"agent", "user", "both"}:
        raise HTTPException(status_code=400, detail="step_mode must be agent, user, or both.")

    partial_rows, stop_index = _build_step_partial_history(body)
    new_turns = body.new_turns_limit or _default_new_turns_for_step(step_mode)

    simulation_stub: dict[str, Any] = {}
    run_body = _step_to_run_request(body, max_turns=new_turns)
    request_body = _build_simulate_request_body(
        simulation=simulation_stub,
        test=None,
        body=run_body,
        partial_rows=partial_rows,
        include_evaluation=body.evaluate,
    )

    if not str(body.agent_id or "").strip():
        raise HTTPException(
            status_code=422,
            detail={
                "code": "agent_id_required",
                "message": "Provide agent_id for standalone step runs.",
            },
        )
    agent_id = await _resolve_agent_id(simulation=simulation_stub, requested_agent_id=body.agent_id)
    response = await _execute_simulate(
        agent_id=agent_id,
        request_body=request_body,
        trace_id=trace_id,
        route=route,
        started=started,
        meta={
            "step_mode": step_mode,
            "stop_index": stop_index,
            "partial_turn_count": len(partial_rows),
        },
    )

    if response.status_code != 200:
        return response

    payload = json.loads(response.body.decode("utf-8"))
    _attach_step_merge(payload, partial_rows=partial_rows, body=body)
    return JSONResponse(status_code=200, content=payload)


def _attach_step_merge(payload: dict[str, Any], *, partial_rows: list[dict[str, Any]], body: StepConversationRequest) -> None:
    new_turns_rows = payload.get("new_turns") if isinstance(payload.get("new_turns"), list) else []
    if body.expected_tool_name:
        payload["tool_check"] = _tool_invocation_check(new_turns_rows, body.expected_tool_name, pass_if_any=True)
    merged = list(partial_rows)
    for idx, row in enumerate(new_turns_rows):
        if not isinstance(row, dict):
            continue
        merged.append(
            {
                "role": row.get("role"),
                "message": row.get("message"),
                "time_in_call_secs": len(partial_rows) + idx,
                "tool_calls": row.get("tool_calls") or [],
                "tool_results": row.get("tool_results") or [],
                "latency_ms": row.get("latency_ms"),
            }
        )
    payload["merged_history"] = merged


@router.post("/simulations/{file_name}/step")
async def step_test_simulation(file_name: str, body: StepConversationRequest) -> JSONResponse:
    if not sim_store._FILENAME_RE.match(file_name):
        raise HTTPException(status_code=400, detail="Invalid simulation file name.")

    path = sim_store._simulations_dir() / file_name
    simulation = sim_store._load_json_file(path)
    if not body.agent_id:
        body.agent_id = await _resolve_agent_id(simulation=simulation, requested_agent_id=None)

    trace_id = uuid.uuid4().hex
    route = f"/api/elevenlabs/tests/simulations/{file_name}/step"
    started = time.time()
    step_mode = str(body.step_mode or "agent").strip().lower()
    partial_rows, stop_index = _build_step_partial_history(body)
    new_turns = body.new_turns_limit or _default_new_turns_for_step(step_mode)

    run_body = _step_to_run_request(body, max_turns=new_turns)
    request_body = _build_simulate_request_body(
        simulation=simulation,
        test=None,
        body=run_body,
        partial_rows=partial_rows,
        include_evaluation=body.evaluate,
    )

    response = await _execute_simulate(
        agent_id=body.agent_id,
        request_body=request_body,
        trace_id=trace_id,
        route=route,
        started=started,
        meta={
            "file_name": file_name,
            "step_mode": step_mode,
            "stop_index": stop_index,
            "partial_turn_count": len(partial_rows),
        },
    )
    if response.status_code != 200:
        return response

    payload = json.loads(response.body.decode("utf-8"))
    _attach_step_merge(payload, partial_rows=partial_rows, body=body)
    return JSONResponse(status_code=200, content=payload)
