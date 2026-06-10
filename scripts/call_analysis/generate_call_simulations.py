#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, request


BOOKING_INTENT_RE = re.compile(
    r"\b(book|booking|booked|availability|service(?:d|ing)?|repair|workshop|bring (?:my|the) (?:bike|scooter))\b",
    re.IGNORECASE,
)
INTERNAL_LEAK_RE = re.compile(r"(trace[_ ]?id|internal|backend error|payload|raw json|diagnostic)", re.IGNORECASE)
NAME_RE = re.compile(r"\b(?:my name is|i am|i'm)\s+([A-Za-z][A-Za-z'\- ]{1,48})", re.IGNORECASE)


@dataclass
class TurnEvent:
    role: str
    at_seconds: int
    text: str
    llm_seconds: float | None
    workflow_route_seconds: float | None
    asr_ms: int | None
    tts_ms: int | None
    tool_dispatch: list[dict[str, Any]]
    tool_results: list[dict[str, Any]]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate repeatable detailed call simulations from call-analysis CSV export."
    )
    parser.add_argument("--csv", required=True, help="Path to call-analysis-export CSV")
    parser.add_argument(
        "--out-dir",
        default="artefacts/call-simulations",
        help="Output directory for per-call simulation JSON files",
    )
    parser.add_argument(
        "--base-url",
        default="https://ghoststack.rideai.com.au",
        help="Base URL for transcript enrichment endpoint",
    )
    parser.add_argument(
        "--voice-key",
        default="",
        help="Optional X-Ghost-Voice-Key header for protected transcript endpoint",
    )
    parser.add_argument("--limit", type=int, default=0, help="Optional max rows to process")
    parser.add_argument(
        "--no-fetch-transcript",
        action="store_true",
        help="Do not call transcript endpoint, use CSV-only fields",
    )
    return parser.parse_args()


def safe_slug(value: str, *, fallback: str) -> str:
    base = re.sub(r"\s+", "_", value.strip())
    base = re.sub(r"[^A-Za-z0-9_]+", "", base)
    base = base.strip("_")
    return (base[:72] or fallback)


def parse_json_maybe(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def fetch_transcript(base_url: str, conversation_id: str, voice_key: str) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}/api/elevenlabs/analysis/conversations/{conversation_id}/transcript"
    headers = {"Accept": "application/json"}
    if voice_key.strip():
        headers["X-Ghost-Voice-Key"] = voice_key.strip()
    req = request.Request(url=url, method="GET", headers=headers)
    with request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode("utf-8")
    data = json.loads(body)
    if not isinstance(data, dict):
        return {"turns": []}
    return data


def _extract_latency_seconds(metrics_payload: dict[str, Any], needle: str) -> list[float]:
    collected: list[float] = []
    metrics = metrics_payload.get("metrics")
    if not isinstance(metrics, dict):
        return collected
    for key, value in metrics.items():
        if needle not in key.lower():
            continue
        if isinstance(value, dict):
            elapsed = value.get("elapsed_time")
            if isinstance(elapsed, (int, float)):
                collected.append(float(elapsed))
    return collected


def _first_int_ms(values: list[float]) -> int | None:
    if not values:
        return None
    return int(round(values[0] * 1000))


def _first_float(values: list[float]) -> float | None:
    if not values:
        return None
    return round(values[0], 3)


def _normalize_tool_result(raw: dict[str, Any]) -> dict[str, Any]:
    result_obj = parse_json_maybe(raw.get("result_value"))
    return {
        "request_id": raw.get("request_id"),
        "tool_name": raw.get("tool_name"),
        "type": raw.get("type"),
        "is_error": bool(raw.get("is_error", False)),
        "is_blocked": bool(raw.get("is_blocked", False)),
        "latency_ms": int(round(float(raw.get("tool_latency_secs", 0.0)) * 1000)) if raw.get("tool_latency_secs") else None,
        "result": result_obj if result_obj is not None else raw.get("result_value"),
    }


def normalize_turns(turns: list[dict[str, Any]]) -> tuple[list[TurnEvent], dict[str, dict[str, Any]]]:
    by_request_id: dict[str, dict[str, Any]] = {}
    for turn in turns:
        for tool_result in turn.get("tool_results", []) or []:
            if isinstance(tool_result, dict):
                rid = str(tool_result.get("request_id") or "").strip()
                if rid:
                    by_request_id[rid] = _normalize_tool_result(tool_result)

    timeline: list[TurnEvent] = []
    for turn in turns:
        metrics = turn.get("metrics") if isinstance(turn.get("metrics"), dict) else {}
        llm_secs = _first_float(_extract_latency_seconds(metrics, "llm"))
        workflow_secs = _first_float(_extract_latency_seconds(metrics, "workflow"))
        asr_ms = _first_int_ms(_extract_latency_seconds(metrics, "asr"))
        tts_ms = _first_int_ms(_extract_latency_seconds(metrics, "tts"))

        tool_calls = []
        for tool_call in turn.get("tool_calls", []) or []:
            if not isinstance(tool_call, dict):
                continue
            rid = str(tool_call.get("request_id") or "").strip()
            mapped_result = by_request_id.get(rid)
            tool_calls.append(
                {
                    "request_id": rid or None,
                    "tool_name": tool_call.get("tool_name"),
                    "tool_type": tool_call.get("type"),
                    "params": parse_json_maybe(tool_call.get("params_as_json")) or tool_call.get("params_as_json"),
                    "dispatch_observed": bool(tool_call.get("tool_has_been_called", False)),
                    "result_status": (
                        "succeeded"
                        if mapped_result and not mapped_result.get("is_error", False)
                        else "failed"
                        if mapped_result and mapped_result.get("is_error", False)
                        else "pending_or_missing"
                    ),
                }
            )

        tool_results = []
        for tool_result in turn.get("tool_results", []) or []:
            if isinstance(tool_result, dict):
                tool_results.append(_normalize_tool_result(tool_result))

        timeline.append(
            TurnEvent(
                role=str(turn.get("role") or "unknown"),
                at_seconds=int(turn.get("start_time_seconds") or 0),
                text=str(turn.get("message") or "").strip(),
                llm_seconds=llm_secs,
                workflow_route_seconds=workflow_secs,
                asr_ms=asr_ms,
                tts_ms=tts_ms,
                tool_dispatch=tool_calls,
                tool_results=tool_results,
            )
        )
    return timeline, by_request_id


def extract_user_name(row: dict[str, str], timeline: list[TurnEvent]) -> str:
    user_data = str(row.get("user_data_captured") or "").strip()
    if user_data:
        for item in user_data.split("|"):
            candidate = item.strip()
            if candidate.lower().startswith("name:"):
                name = candidate.split(":", 1)[-1].strip()
                if name:
                    return name
    for event in timeline:
        if event.role.lower() != "user":
            continue
        match = NAME_RE.search(event.text)
        if match:
            return match.group(1).strip()
    return "Unknown_User"


def build_brief_summary(row: dict[str, str], timeline: list[TurnEvent]) -> str:
    title = str(row.get("title") or "").strip()
    if title:
        return title
    summary = str(row.get("transcript_summary") or "").strip()
    if summary:
        return summary[:80]
    for event in timeline:
        if event.role.lower() == "user" and event.text:
            return event.text[:80]
    return str(row.get("id") or "Conversation")


def detect_booking_intent_time(timeline: list[TurnEvent]) -> int | None:
    for event in timeline:
        if event.role.lower() == "user" and BOOKING_INTENT_RE.search(event.text):
            return event.at_seconds
    return None


def build_transcript_render(timeline: list[TurnEvent]) -> list[str]:
    lines: list[str] = []
    for event in timeline:
        lines.append(f"{event.role}")
        lines.append(f"{event.at_seconds}s")
        lines.append(event.text or "...")
        if event.asr_ms is not None:
            lines.append(f"ASR {event.asr_ms} ms")
        if event.llm_seconds is not None:
            lines.append(f"LLM {event.llm_seconds} s")
        if event.workflow_route_seconds is not None:
            lines.append(f"Workflow route {event.workflow_route_seconds} s")
        if event.tts_ms is not None:
            lines.append(f"TTS {event.tts_ms} ms")
        for dispatch in event.tool_dispatch:
            lines.append(f"Tool dispatch: {dispatch.get('tool_name')}")
            lines.append(f"Type: {dispatch.get('tool_type')}")
            lines.append("Show request")
        for result in event.tool_results:
            status = "failed" if result.get("is_error") else "succeeded"
            lines.append(f"Tool {status}: {result.get('tool_name')}")
            latency = result.get("latency_ms")
            if latency is not None:
                lines.append(f"Result {latency} ms")
            lines.append("Show result payload")
    return lines


def evaluate_tooling(timeline: list[TurnEvent], booking_intent_s: int | None) -> dict[str, Any]:
    dispatches: list[dict[str, Any]] = [d for event in timeline for d in event.tool_dispatch]
    results: list[dict[str, Any]] = [r for event in timeline for r in event.tool_results]
    tool_counter = Counter(str(d.get("tool_name") or "unknown") for d in dispatches)
    success_count = sum(1 for r in results if not r.get("is_error"))
    fail_count = sum(1 for r in results if r.get("is_error"))
    hubtiger_dispatches = [d for d in dispatches if "hubtiger" in str(d.get("tool_name") or "").lower()]
    first_hubtiger = min((e.at_seconds for e in timeline if any("hubtiger" in str(d.get("tool_name") or "").lower() for d in e.tool_dispatch)), default=None)

    return {
        "tool_dispatch_count": len(dispatches),
        "tool_result_count": len(results),
        "tool_success_count": success_count,
        "tool_failure_count": fail_count,
        "tool_success_rate": round((success_count / len(results)) * 100.0, 2) if results else None,
        "top_tools": [{"tool_name": name, "count": count} for name, count in tool_counter.most_common(10)],
        "hubtiger_dispatch_count": len(hubtiger_dispatches),
        "first_hubtiger_dispatch_seconds": first_hubtiger,
        "booking_intent_to_first_hubtiger_seconds": (first_hubtiger - booking_intent_s) if first_hubtiger is not None and booking_intent_s is not None else None,
    }


def evaluate_reasoning_and_ux(timeline: list[TurnEvent]) -> dict[str, Any]:
    agent_turns = [e for e in timeline if e.role.lower() == "agent"]
    user_turns = [e for e in timeline if e.role.lower() == "user"]
    clarification_count = sum(1 for e in agent_turns if e.text.endswith("?"))
    internal_leaks = [e.text for e in agent_turns if INTERNAL_LEAK_RE.search(e.text)]
    first_tool_index = next((idx for idx, event in enumerate(timeline) if event.tool_dispatch), None)
    turns_before_tool = first_tool_index if first_tool_index is not None else len(timeline)

    response_gaps: list[int] = []
    for user_event in user_turns:
        next_agent = next((a for a in agent_turns if a.at_seconds >= user_event.at_seconds), None)
        if next_agent:
            response_gaps.append(max(0, next_agent.at_seconds - user_event.at_seconds))

    return {
        "clarification_questions_count": clarification_count,
        "turns_before_first_tool": turns_before_tool,
        "internal_leakage_detected": bool(internal_leaks),
        "internal_leakage_examples": internal_leaks[:3],
        "avg_user_to_agent_response_gap_seconds": round(sum(response_gaps) / len(response_gaps), 2) if response_gaps else None,
        "opening_present": bool(agent_turns and "magic mike" in agent_turns[0].text.lower()),
    }


def evaluate_booking_capability(timeline: list[TurnEvent], booking_intent_s: int | None) -> dict[str, Any]:
    dispatches = [d for event in timeline for d in event.tool_dispatch]
    results = [r for event in timeline for r in event.tool_results]
    availability_times = [
        event.at_seconds
        for event in timeline
        if any("booking_availability" in str(d.get("tool_name") or "").lower() or "availability" in str(d.get("tool_name") or "").lower() for d in event.tool_dispatch)
    ]
    write_times = [
        event.at_seconds
        for event in timeline
        if any(
            key in str(d.get("tool_name") or "").lower()
            for d in event.tool_dispatch
            for key in ("booking_create", "booking_update", "quote_add_line_item")
        )
    ]
    pending_review = any(
        "looked at by a staff member" in json.dumps(result.get("result") or "", ensure_ascii=False).lower()
        for result in results
    )
    return {
        "booking_intent_detected": booking_intent_s is not None,
        "booking_availability_tool_used": bool(availability_times),
        "booking_write_tool_used": bool(write_times),
        "pending_human_review_observed": pending_review,
        "time_to_first_availability_check_seconds": (
            availability_times[0] - booking_intent_s if availability_times and booking_intent_s is not None else None
        ),
        "time_to_booking_write_attempt_seconds": (
            write_times[0] - booking_intent_s if write_times and booking_intent_s is not None else None
        ),
        "booking_capability_statement": (
            "LLM can route booking checks. Live write completion depends on staff review gate."
            if availability_times
            else "No booking tool evidence observed in this call."
        ),
    }


def build_repeatable_tests(row: dict[str, str], timeline: list[TurnEvent], booking_eval: dict[str, Any]) -> list[dict[str, Any]]:
    conversation_id = str(row.get("id") or "unknown")
    first_user_utterance = next((e.text for e in timeline if e.role.lower() == "user" and e.text), "Caller asks for assistance.")
    tests: list[dict[str, Any]] = []

    tests.append(
        {
            "id": f"{conversation_id}-replay",
            "name": "Real call replay simulation",
            "objective": "Re-run the exact intent progression and verify tool routing + voice response quality.",
            "steps": [
                {"step": 1, "action": f"Start call with: {first_user_utterance}", "expected": "Agent greets and identifies intent."},
                {"step": 2, "action": "Provide identifiers exactly as in transcript.", "expected": "Agent asks only missing required details."},
                {"step": 3, "action": "Observe all tool dispatches and result statuses.", "expected": "No tool call is skipped or duplicated unexpectedly."},
                {"step": 4, "action": "Close call as user confirms/declines.", "expected": "Agent gives clear next step and polite wrap-up."},
            ],
            "assertions": [
                "No internal diagnostics spoken to caller",
                "Tool sequence matches transcript intent order",
                "Agent remains concise and action-oriented",
            ],
        }
    )

    tests.append(
        {
            "id": f"{conversation_id}-stale-read",
            "name": "Stale data retry path",
            "objective": "Validate no_cache recovery behavior for read tools.",
            "steps": [
                {"step": 1, "action": "Caller says latest status/availability sounds outdated.", "expected": "Agent acknowledges and retries once with cache_mode=no_cache."},
                {"step": 2, "action": "Return updated tool payload.", "expected": "Agent presents refreshed answer without exposing raw payload."},
            ],
            "assertions": [
                "Exactly one no_cache retry",
                "Fallback offered if still unavailable",
            ],
        }
    )

    if booking_eval.get("booking_intent_detected"):
        tests.append(
            {
                "id": f"{conversation_id}-booking-flow",
                "name": "Booking end-to-end capability",
                "objective": "Assess practical booking ability and elapsed time to booking action.",
                "steps": [
                    {"step": 1, "action": "Caller requests booking with store/date context.", "expected": "Agent checks availability first."},
                    {"step": 2, "action": "Caller selects offered slot.", "expected": "Agent triggers booking create/update path."},
                    {"step": 3, "action": "Observe write outcome.", "expected": "Agent states pending staff review outcome when write gate is enabled."},
                ],
                "assertions": [
                    "Availability checked before write attempt",
                    "Booking write path invoked when details are complete",
                    "Completion wording matches policy",
                ],
            }
        )

    tests.append(
        {
            "id": f"{conversation_id}-tool-failure",
            "name": "Tool failure safety behavior",
            "objective": "Verify UX quality when a required tool fails.",
            "steps": [
                {"step": 1, "action": "Simulate webhook/tool timeout.", "expected": "Agent does not hallucinate result."},
                {"step": 2, "action": "Continue conversation.", "expected": "Agent offers callback/handoff with one focused follow-up question."},
            ],
            "assertions": [
                "No fabricated booking/status confirmation",
                "Clear safe fallback provided",
            ],
        }
    )
    return tests


def build_simulation_payload(
    row: dict[str, str],
    timeline: list[TurnEvent],
    transcript_source: str,
) -> dict[str, Any]:
    booking_intent_s = detect_booking_intent_time(timeline)
    tooling = evaluate_tooling(timeline, booking_intent_s)
    reasoning_ux = evaluate_reasoning_and_ux(timeline)
    booking = evaluate_booking_capability(timeline, booking_intent_s)
    user_name = extract_user_name(row, timeline)
    brief_summary = build_brief_summary(row, timeline)

    return {
        "simulation_schema_version": "1.0",
        "conversation": {
            "id": row.get("id"),
            "title": row.get("title"),
            "status": row.get("status"),
            "user": user_name,
            "brief_summary": brief_summary,
            "duration_seconds": int(float(row.get("duration_seconds") or 0)) if str(row.get("duration_seconds") or "").strip() else None,
            "source": transcript_source,
        },
        "full_transcript_playback": [
            {
                "role": e.role,
                "at_seconds": e.at_seconds,
                "text": e.text,
                "asr_ms": e.asr_ms,
                "llm_seconds": e.llm_seconds,
                "workflow_route_seconds": e.workflow_route_seconds,
                "tts_ms": e.tts_ms,
                "tool_dispatch": e.tool_dispatch,
                "tool_results": e.tool_results,
            }
            for e in timeline
        ],
        "full_transcript_render": build_transcript_render(timeline),
        "evaluation": {
            "tools": tooling,
            "llm_reasoning": {
                "clarification_questions_count": reasoning_ux["clarification_questions_count"],
                "turns_before_first_tool": reasoning_ux["turns_before_first_tool"],
                "internal_leakage_detected": reasoning_ux["internal_leakage_detected"],
                "internal_leakage_examples": reasoning_ux["internal_leakage_examples"],
            },
            "user_experience": {
                "opening_present": reasoning_ux["opening_present"],
                "avg_user_to_agent_response_gap_seconds": reasoning_ux["avg_user_to_agent_response_gap_seconds"],
                "experience_summary": (
                    "Customer-safe and concise flow"
                    if not reasoning_ux["internal_leakage_detected"]
                    else "Contains possible internal leakage phrasing to address"
                ),
            },
            "hubtiger_booking_capability": booking,
        },
        "repeatable_real_world_tests": build_repeatable_tests(row, timeline, booking),
    }


def row_limit(rows: list[dict[str, str]], limit: int) -> list[dict[str, str]]:
    if limit <= 0:
        return rows
    return rows[:limit]


def main() -> int:
    args = parse_args()
    csv_path = Path(args.csv).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not csv_path.exists():
        print(f"CSV not found: {csv_path}")
        return 2

    with csv_path.open("r", encoding="utf-8-sig", newline="") as fp:
        reader = csv.DictReader(fp)
        rows = list(reader)

    if not rows:
        print("CSV has no rows.")
        return 1

    manifest: dict[str, Any] = {
        "source_csv": str(csv_path),
        "output_dir": str(out_dir),
        "generated_count": 0,
        "files": [],
        "errors": [],
    }

    for row in row_limit(rows, args.limit):
        conversation_id = str(row.get("id") or "").strip()
        transcript_source = "csv_only"
        timeline: list[TurnEvent] = []
        try:
            if conversation_id and not args.no_fetch_transcript:
                payload = fetch_transcript(args.base_url, conversation_id, args.voice_key)
                turns = payload.get("turns") if isinstance(payload.get("turns"), list) else []
                timeline, _ = normalize_turns(turns)
                transcript_source = "live_transcript_endpoint"
        except (error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            manifest["errors"].append({"conversation_id": conversation_id, "error": f"transcript_fetch_failed: {exc}"})

        if not timeline:
            # CSV fallback: create minimal two-turn simulation from summary when full transcript is unavailable.
            summary = str(row.get("transcript_summary") or "").strip() or "Transcript unavailable in CSV row."
            timeline = [
                TurnEvent(
                    role="agent",
                    at_seconds=0,
                    text="Transcript detail unavailable from endpoint. Using CSV summary fallback.",
                    llm_seconds=None,
                    workflow_route_seconds=None,
                    asr_ms=None,
                    tts_ms=None,
                    tool_dispatch=[],
                    tool_results=[],
                ),
                TurnEvent(
                    role="system",
                    at_seconds=1,
                    text=summary,
                    llm_seconds=None,
                    workflow_route_seconds=None,
                    asr_ms=None,
                    tts_ms=None,
                    tool_dispatch=[],
                    tool_results=[],
                ),
            ]

        simulation = build_simulation_payload(row, timeline, transcript_source)
        user_slug = safe_slug(str(simulation["conversation"]["user"]), fallback="Unknown_User")
        brief_slug = safe_slug(str(simulation["conversation"]["brief_summary"]), fallback=conversation_id or "Call")
        filename = f"JSON_{user_slug}&{brief_slug}_SIMULATION.json"
        out_path = out_dir / filename
        if out_path.exists():
            suffix = safe_slug(conversation_id or "dup", fallback="dup")
            out_path = out_dir / f"JSON_{user_slug}&{brief_slug}_{suffix}_SIMULATION.json"
        out_path.write_text(json.dumps(simulation, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        manifest["generated_count"] += 1
        manifest["files"].append({"conversation_id": conversation_id, "path": str(out_path)})

    manifest_path = out_dir / "SIMULATION_MANIFEST.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Generated {manifest['generated_count']} simulations in {out_dir}")
    print(f"Manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
