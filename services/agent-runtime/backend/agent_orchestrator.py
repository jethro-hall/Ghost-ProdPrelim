"""
Deterministic ReAct orchestrator.

The LLM proposes. The runtime disposes.
Claude emits JSON tool calls. This module executes them, emits events, manages
the approval gate, runs the verifier, and handles remediation loops.

Flow:
  receive question
  → run.started
  → ReAct loop (max MAX_STEPS iterations):
      → context_manager.build_prompt()
      → Bedrock Converse (toolChoice=auto)
      → for each response block:
          → text delta → agent.message.delta event
          → tool call  → policy_engine.evaluate()
                         → if approval needed: approval.requested + wait
                         → tool_registry.execute()
                         → tool.call.completed / tool.call.failed
                         → artifact events
                         → observation appended to messages
      → if stopReason == end_turn AND submit_for_review was called:
          → verification.started
          → verifier_agent.run_verifier()
          → if FAIL: verification.failed → agent.remediation.started → continue
          → if PASS: verification.passed → agent.final → run.completed

Soft-remediation for end_turn without submit_for_review:
  A nudge is injected but does NOT consume a step budget slot unless the model
  ignores it a second consecutive time. This prevents a talkative model from
  exhausting the step budget in nudge cycles.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any

import boto3

from .config import get_settings
from .context_manager import SYSTEM_CONTRACT, build_prompt, tool_schemas_for_bedrock
from .observability import log_event, new_span_id, new_trace_id, wrap_outbound_call
from .policy_engine import evaluate as policy_evaluate
from .repositories import (
    complete_tool_call,
    get_agent_run,
    get_artifacts,
    get_run_events,
    insert_agent_run,
    insert_approval,
    insert_artifact,
    insert_run_event,
    insert_tool_call,
    next_seq,
    resolve_approval,
    update_agent_run_status,
    update_agent_run_summary,
    update_agent_run_trace_id,
)
from .sandbox_runner import create_sandbox, destroy_sandbox
from .tool_registry import execute as registry_execute
from .verifier_agent import run_verifier

logger = logging.getLogger(__name__)
_settings = get_settings()

# In-memory queues for approval decisions (keyed by approval_id)
_approval_queues: dict[str, asyncio.Queue[str]] = {}

# In-memory SSE subscriber queues (keyed by run_id → list of asyncio.Queue)
_sse_subscribers: dict[str, list[asyncio.Queue[dict[str, Any] | None]]] = {}


# ── SSE subscriber management ─────────────────────────────────────────────────

def subscribe_to_run(run_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _sse_subscribers.setdefault(run_id, []).append(q)
    return q


def unsubscribe_from_run(run_id: str, q: asyncio.Queue) -> None:
    subs = _sse_subscribers.get(run_id, [])
    if q in subs:
        subs.remove(q)


def _fan_out_event(run_id: str, event: dict[str, Any]) -> None:
    for q in _sse_subscribers.get(run_id, []):
        q.put_nowait(event)


# ── Event emitter ─────────────────────────────────────────────────────────────

def _emit(
    run_id: str,
    event_type: str,
    payload: dict[str, Any] | None = None,
    title: str | None = None,
    status: str | None = None,
    visible: bool = True,
    parent_event_id: str | None = None,
) -> str:
    event_id = str(uuid.uuid4())
    seq = next_seq(run_id)
    insert_run_event(
        event_id=event_id,
        run_id=run_id,
        seq=seq,
        event_type=event_type,
        title=title,
        payload=payload,
        visible=visible,
        parent_event_id=parent_event_id,
        status=status,
    )
    event_dict = {
        "id": event_id,
        "run_id": run_id,
        "seq": seq,
        "type": event_type,
        "title": title,
        "payload": payload,
        "status": status,
    }
    _fan_out_event(run_id, event_dict)
    logger.debug("Event [%s] %s %s", seq, event_type, title or "")
    return event_id


# ── Bedrock client ────────────────────────────────────────────────────────────

def _bedrock_client():
    kwargs: dict[str, Any] = {"region_name": _settings.aws_default_region}
    if _settings.aws_access_key_id:
        kwargs["aws_access_key_id"] = _settings.aws_access_key_id
    if _settings.aws_secret_access_key:
        kwargs["aws_secret_access_key"] = _settings.aws_secret_access_key
    return boto3.client("bedrock-runtime", **kwargs)


# ── Tool call execution ───────────────────────────────────────────────────────

async def _execute_tool_call(
    run_id: str,
    call_id: str,
    tool_name: str,
    args: dict[str, Any],
    trace_id: str,
) -> tuple[str, str]:
    """
    Execute one tool call.
    Returns (tool_result_content_str, status).
    """
    tc_id = str(uuid.uuid4())
    insert_tool_call(
        tc_id=tc_id,
        run_id=run_id,
        call_id=call_id,
        tool_name=tool_name,
        args=args,
    )

    decision = policy_evaluate(tool_name, args)

    if decision.block_reason:
        msg = f"Tool call blocked: {decision.block_reason}"
        _emit(run_id, "tool.call.failed", payload={"tool_name": tool_name, "reason": msg}, title=f"Blocked: {tool_name}")
        complete_tool_call(tc_id=tc_id, status="failed", error=msg)
        return msg, "failed"

    if decision.requires_approval:
        approval_id = str(uuid.uuid4())
        insert_approval(
            approval_id=approval_id,
            run_id=run_id,
            tool_call_id=tc_id,
            risk_level=decision.risk_level,
            request={"tool_name": tool_name, "args": args},
        )
        _emit(
            run_id, "approval.requested",
            payload={
                "approval_id": approval_id,
                "tool_name": tool_name,
                "risk_level": decision.risk_level,
                "args": args,
            },
            title=f"Approval required: {tool_name}",
        )

        q: asyncio.Queue[str] = asyncio.Queue()
        _approval_queues[approval_id] = q
        try:
            decision_str = await asyncio.wait_for(q.get(), timeout=300)
        except asyncio.TimeoutError:
            decision_str = "reject"
        finally:
            _approval_queues.pop(approval_id, None)

        if decision_str == "reject":
            msg = f"Operator rejected tool call: {tool_name}"
            _emit(run_id, "tool.call.failed", payload={"tool_name": tool_name, "reason": msg}, title=f"Rejected: {tool_name}")
            complete_tool_call(tc_id=tc_id, status="cancelled", error=msg)
            return msg, "cancelled"

    _emit(run_id, "tool.stdout.delta", payload={"text": f"Executing {tool_name}..."}, visible=False)
    import asyncio as _asyncio
    result = await _asyncio.get_event_loop().run_in_executor(
        None,
        lambda: registry_execute(tool_name=tool_name, args=args, run_id=run_id, call_id=call_id, trace_id=trace_id)
    )

    for artifact_meta in (result.artifacts or []):
        try:
            insert_artifact(
                artifact_id=artifact_meta.get("artifact_id", str(uuid.uuid4())),
                run_id=run_id,
                path=artifact_meta.get("path", ""),
                name=artifact_meta.get("name", "artifact"),
                sha256=artifact_meta.get("sha256", ""),
                size_bytes=artifact_meta.get("size_bytes", 0),
                description=artifact_meta.get("description", ""),
            )
            _emit(
                run_id, "artifact.created",
                payload=artifact_meta,
                title=f"Artifact: {artifact_meta.get('name', 'artifact')}",
            )
        except Exception as exc:
            logger.warning("Artifact insert failed: %s", exc)

    complete_tool_call(
        tc_id=tc_id,
        status=result.status,
        output_ref=result.full_output_ref,
        exit_code=result.exit_code,
        error=result.stderr[:500] if result.status == "failed" else None,
    )

    _emit(
        run_id,
        "tool.call.completed" if result.status == "completed" else "tool.call.failed",
        payload={
            "tool_name": tool_name,
            "exit_code": result.exit_code,
            "status": result.status,
        },
        title=f"{'✓' if result.status == 'completed' else '✗'} {tool_name}",
    )

    return result.observation_for_model, result.status


# ── Approval resolution (called from API) ────────────────────────────────────

def resolve_approval_decision(approval_id: str, decision: str) -> None:
    resolve_approval(approval_id, decision)
    q = _approval_queues.get(approval_id)
    if q:
        q.put_nowait(decision)


# ── Main orchestrator ─────────────────────────────────────────────────────────

async def run_agent(
    run_id: str,
    question: str,
    model: str | None = None,
    max_steps: int | None = None,
) -> None:
    """Main agent run. Called as an asyncio background task."""
    resolved_model = model or _settings.agent_runtime_default_model
    effective_max = max_steps or _settings.agent_runtime_max_steps

    # Mint a trace_id for this run and persist it so logs are correlated
    trace_id = new_trace_id()
    update_agent_run_trace_id(run_id, trace_id)

    update_agent_run_status(run_id, "running")
    _emit(run_id, "run.started", payload={"model": resolved_model, "trace_id": trace_id}, title="Run started")
    _emit(run_id, "agent.analyzing", title="Studying request")

    create_sandbox(run_id)

    messages: list[dict[str, Any]] = [
        {"role": "user", "content": [{"text": question}]}
    ]

    tool_schemas = tool_schemas_for_bedrock()
    bedrock = _bedrock_client()
    step_count = 0
    public_plan = ""
    verified_claims: list[str] = []
    uncertain_items: list[str] = []
    tool_call_names: list[str] = []
    proposed_final: str = ""
    submit_review_args: dict[str, Any] | None = None
    last_text_parts: list[str] = []

    # Soft-remediation counter: track how many consecutive nudges have been sent
    # without the model calling submit_for_review. Only burns a step slot on the
    # second consecutive failure so a single talkative response doesn't stall the run.
    nudge_count = 0

    try:
        while step_count < effective_max:
            step_count += 1
            logger.info("Run %s step %d/%d trace=%s", run_id, step_count, effective_max, trace_id)

            context = build_prompt(run_id, messages)
            system_text = context["system"]

            import asyncio as _asyncio
            _emit(run_id, "agent.analyzing", title="Thinking…", visible=True)

            # ── Bedrock Converse call (instrumented) ──────────────────────────
            bedrock_route = f"bedrock/{resolved_model}/converse"
            bedrock_span = new_span_id()
            bedrock_start = __import__("time").time()
            bedrock_status = "ok"
            bedrock_error: str | None = None
            try:
                def _call_bedrock():
                    return bedrock.converse(
                        modelId=resolved_model,
                        system=[{"text": system_text}],
                        messages=messages,
                        toolConfig={
                            "tools": tool_schemas,
                            "toolChoice": {"auto": {}},
                        },
                        inferenceConfig={
                            "maxTokens": 32000,
                            "temperature": 1.0,
                        },
                    )
                response = await _asyncio.get_event_loop().run_in_executor(None, _call_bedrock)
            except Exception as exc:
                bedrock_status = "error"
                bedrock_error = str(exc)
                logger.error("Bedrock Converse failed: %s", exc, exc_info=True)
                _emit(run_id, "tool.call.failed", payload={"error": str(exc)}, title="LLM call failed")
                update_agent_run_status(run_id, "failed", error=str(exc))
                return
            finally:
                log_event(
                    trace_id=trace_id,
                    span_id=bedrock_span,
                    service="agent-runtime",
                    route=bedrock_route,
                    start_ts=bedrock_start,
                    end_ts=__import__("time").time(),
                    status=bedrock_status,
                    error=bedrock_error,
                )

            stop_reason = response.get("stopReason", "")
            output_message = response.get("output", {}).get("message", {})
            content_blocks = output_message.get("content", [])

            assistant_blocks: list[dict[str, Any]] = []
            tool_use_blocks: list[dict[str, Any]] = []
            text_parts: list[str] = []

            for block in content_blocks:
                b_type = block.get("type") or ("toolUse" if "toolUse" in block else "text" if "text" in block else "unknown")

                if b_type == "text" or ("text" in block and "toolUse" not in block):
                    text = block.get("text", "")
                    if text:
                        text_parts.append(text)
                        assistant_blocks.append({"text": text})
                        _emit(run_id, "agent.message.delta", payload={"text": text}, visible=True)

                        if text.strip().upper().startswith("PLAN:") and not public_plan:
                            public_plan = text.strip()
                            _emit(run_id, "agent.plan.public", payload={"plan": text}, title="Plan")

                elif "toolUse" in block:
                    tool_use = block.get("toolUse") or block
                    tool_use_blocks.append(tool_use)
                    assistant_blocks.append({"toolUse": tool_use} if "toolUse" not in block else block)

            if assistant_blocks:
                messages.append({"role": "assistant", "content": assistant_blocks})
            if text_parts:
                last_text_parts = text_parts

            tool_results: list[dict[str, Any]] = []

            for tool_use in tool_use_blocks:
                call_id = tool_use.get("toolUseId", str(uuid.uuid4()))
                tool_name = tool_use.get("name", "")
                raw_input = tool_use.get("input", {})
                args = raw_input if isinstance(raw_input, dict) else {}

                tool_call_names.append(tool_name)

                _emit(
                    run_id, "tool.call.started",
                    payload={"tool_name": tool_name, "call_id": call_id, "args": _sanitise_args(args)},
                    title=f"Tool: {tool_name}",
                )

                if tool_name == "submit_for_review":
                    submit_review_args = args
                    proposed_final = str(args.get("answer", ""))
                    verified_claims = list(args.get("verified_claims") or [])
                    uncertain_items = list(args.get("uncertain_items") or [])
                    nudge_count = 0
                    _emit(run_id, "verification.started", title="Verifier started")

                    tool_results.append({
                        "toolResult": {
                            "toolUseId": call_id,
                            "content": [{"text": "Review package received. Verifier running."}],
                        },
                    })
                    continue

                observation, status = await _execute_tool_call(
                    run_id, call_id, tool_name, args, trace_id
                )

                tool_results.append({
                    "toolResult": {
                        "toolUseId": call_id,
                        "content": [{"text": observation}],
                        "status": "success" if status == "completed" else "error",
                    },
                })

            if tool_results:
                messages.append({"role": "user", "content": tool_results})

            if submit_review_args is not None:
                artifact_manifest = get_artifacts(run_id)
                _emit(run_id, "verification.started", title="Verifier reviewing answer…")
                review = await _asyncio.get_event_loop().run_in_executor(
                    None,
                    lambda: run_verifier(
                        run_id=run_id,
                        question=question,
                        public_plan=public_plan,
                        tool_call_names=tool_call_names,
                        artifact_manifest=artifact_manifest,
                        proposed_answer=proposed_final,
                        verified_claims=verified_claims,
                        uncertain_items=uncertain_items,
                    )
                )

                if review["status"] == "FAIL":
                    _emit(
                        run_id, "verification.failed",
                        payload={"defects": review["defects"], "confidence": review.get("confidence")},
                        title=f"Verifier FAIL (confidence {review.get('confidence', 0):.2f})",
                    )
                    _emit(run_id, "agent.replanning", title="Remediating verifier defects")

                    defects_text = "\n".join(f"  - {d}" for d in review["defects"])
                    remediation_text = "\n".join(f"  - {r}" for r in review["required_remediation"])
                    messages.append({
                        "role": "user",
                        "content": [{
                            "text": (
                                f"VERIFIER FEEDBACK (independent review agent):\n"
                                f"Status: FAIL\n"
                                f"Defects found:\n{defects_text}\n\n"
                                f"Required remediation:\n{remediation_text}\n\n"
                                "Please address these defects and resubmit using submit_for_review."
                            ),
                        }],
                    })
                    submit_review_args = None
                    continue

                else:
                    _emit(
                        run_id, "verification.passed",
                        payload={"confidence": review.get("confidence"), "summary": review.get("fit_for_purpose_summary", "")},
                        title=f"Verifier PASS (confidence {review.get('confidence', 0):.2f})",
                    )
                    _emit(
                        run_id, "agent.final",
                        payload={"content": proposed_final},
                        title="Final answer",
                    )
                    update_agent_run_summary(run_id, proposed_final[:1000])
                    update_agent_run_status(run_id, "completed")
                    _emit(run_id, "run.completed", title="Run completed")
                    return

            # Natural end_turn without submit_for_review
            if stop_reason == "end_turn" and not tool_use_blocks:
                final_text = "\n".join(text_parts).strip()
                if final_text:
                    nudge_count += 1
                    if nudge_count == 1:
                        # First nudge: inject without consuming a step slot
                        messages.append({
                            "role": "user",
                            "content": [{
                                "text": (
                                    "You produced a text response without calling submit_for_review. "
                                    "Please use submit_for_review with your answer and verified claims "
                                    "so the verifier can check it."
                                ),
                            }],
                        })
                        step_count -= 1  # soft: don't charge this step
                        continue
                    else:
                        # Second consecutive nudge failure: charge it and continue
                        messages.append({
                            "role": "user",
                            "content": [{
                                "text": (
                                    "IMPORTANT: You have not called submit_for_review again. "
                                    "You MUST call submit_for_review now with your findings to complete the task."
                                ),
                            }],
                        })
                        nudge_count = 0

        # Max steps reached — emit a degraded-summary failure card
        degraded_summary = "\n".join(last_text_parts).strip()
        _emit(
            run_id, "run.failed",
            payload={
                "error": f"Max steps ({effective_max}) reached without submit_for_review.",
                "partial_findings": degraded_summary[:2000] if degraded_summary else None,
            },
            title=f"Run did not converge — partial findings available" if degraded_summary else f"Run did not converge",
        )
        update_agent_run_status(run_id, "failed", error=f"Max steps {effective_max} exceeded")

    except Exception as exc:
        logger.error("Orchestrator error for run %s: %s", run_id, exc, exc_info=True)
        _emit(run_id, "tool.call.failed", payload={"error": str(exc)}, title="Runtime error")
        update_agent_run_status(run_id, "failed", error=str(exc))
    finally:
        for q in _sse_subscribers.get(run_id, []):
            q.put_nowait(None)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _sanitise_args(args: dict[str, Any]) -> dict[str, Any]:
    sensitive = {"password", "secret", "api_key", "token", "credential", "key"}
    return {
        k: ("***" if any(s in k.lower() for s in sensitive) else v)
        for k, v in args.items()
    }
