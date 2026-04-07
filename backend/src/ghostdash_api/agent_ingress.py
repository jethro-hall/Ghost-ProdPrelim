from __future__ import annotations

import json

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from .agent_memory import (
    append_message,
    build_history_context,
    build_response_cache_key,
    create_conversation,
    get_agent,
    list_messages,
    lookup_cached_response,
    seed_default_agent_profiles,
    store_cached_response,
)
from .database import SessionLocal, get_session
from .models import AgentConversationRecord
from .runtime import generate_answer, get_active_connection, seed_default_connections, stream_answer
from .runtime_defaults import resolve_query_top_k
from .schemas import ChatRequest, ChatResponse
from .service_common import build_app
from .settings import get_settings
from .telemetry import log_instant_event

settings = get_settings()


def initialize_agent_runtime_state() -> None:
    with SessionLocal() as session:
        seed_default_connections(session)
        seed_default_agent_profiles(session)


async def fetch_query_plan(message: str, corpora: list[str], top_k: int, trace_id: str) -> dict:
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{settings.app_workflow_runtime_url.rstrip('/')}/internal/query-plan",
            json={
                "message": message,
                "corpora": corpora,
                "top_k": top_k,
                "trace_id": trace_id,
            },
        )
        response.raise_for_status()
        return response.json()


def build_query_message(*, message: str, history_context: str) -> str:
    if not history_context:
        return message
    return (
        "Recent conversation memory:\n"
        f"{history_context}\n\n"
        f"Current user request:\n{message}"
    )


def build_answer_prompt(*, agent_name: str, system_prompt: str, query_prompt: str, history_context: str) -> str:
    sections = [
        f"Agent profile: {agent_name}",
        f"Agent instruction:\n{system_prompt}",
    ]
    if history_context:
        sections.append(f"Recent conversation memory:\n{history_context}")
    sections.append(query_prompt)
    return "\n\n".join(section for section in sections if section.strip())


def create_app() -> FastAPI:
    app = build_app(
        service_name="agent-ingress",
        title="GhostDASH Agent Ingress",
        docs_url="/agent/docs",
        redoc_url="/agent/redoc",
        openapi_url="/agent/openapi.json",
        startup_hooks=[initialize_agent_runtime_state],
    )

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/agent/chat", response_model=ChatResponse)
    async def agent_chat(
        body: ChatRequest,
        request: Request,
        session: Session = Depends(get_session),
    ) -> ChatResponse:
        top_k = resolve_query_top_k(session, body.top_k)
        agent = get_agent(session, body.agent_id)
        conversation = session.get(AgentConversationRecord, body.conversation_id) if body.conversation_id else None
        if body.conversation_id and conversation is None:
            raise HTTPException(404, "conversation not found")
        if conversation is not None and conversation.agent_id != agent.id:
            raise HTTPException(400, "conversation does not belong to the selected agent")
        if conversation is None:
            conversation = create_conversation(
                session,
                agent_id=agent.id,
                message=body.message,
                corpora=body.corpora,
                api_mode=body.api_mode,
            )
            session.commit()
            session.refresh(conversation)
        history = list_messages(session, conversation.id, limit=max(settings.app_agent_memory_window_messages * 2, 20))
        history_context = build_history_context(history, window_messages=settings.app_agent_memory_window_messages)
        cache_key = build_response_cache_key(
            agent=agent,
            history_context=history_context,
            message=body.message,
            corpora=body.corpora,
            api_mode=body.api_mode,
        )
        cached = lookup_cached_response(session, agent_id=agent.id, request_hash=cache_key)
        if cached is not None:
            append_message(session, conversation_id=conversation.id, agent_id=agent.id, role="user", content=body.message)
            append_message(
                session,
                conversation_id=conversation.id,
                agent_id=agent.id,
                role="assistant",
                content=cached.answer_text,
                query_mode=cached.query_mode,
                citations=cached.citations_json,
                api_mode=body.api_mode,
            )
            conversation.corpora_json = list(body.corpora)
            conversation.api_mode = body.api_mode
            session.commit()
            log_instant_event(
                trace_id=request.state.trace_id,
                service="agent-ingress",
                route="chat_response_cache.hit",
                status="ok",
                details={"agent_id": agent.id, "conversation_id": conversation.id},
            )
            return ChatResponse(
                answer=cached.answer_text,
                query_mode=cached.query_mode,
                citations=cached.citations_json,
                conversation_id=conversation.id,
                agent_id=agent.id,
                cached=True,
            )
        plan = await fetch_query_plan(build_query_message(message=body.message, history_context=history_context), body.corpora, top_k, request.state.trace_id)
        citations = plan.get("citations", [])
        if plan.get("direct_answer"):
            answer = plan["direct_answer"]
        else:
            answer = ""
        connection = get_active_connection(session, "openai")
        if not answer:
            answer = generate_answer(
                build_answer_prompt(
                    agent_name=agent.name,
                    system_prompt=agent.system_prompt,
                    query_prompt=plan["prompt"],
                    history_context=history_context,
                ),
                connection,
                api_mode=body.api_mode,
                system_prompt=agent.system_prompt,
                model_id=agent.model_id,
                temperature=agent.temperature,
                max_tokens=agent.max_tokens,
                trace_id=request.state.trace_id,
                service="agent-ingress",
            )
        append_message(session, conversation_id=conversation.id, agent_id=agent.id, role="user", content=body.message)
        append_message(
            session,
            conversation_id=conversation.id,
            agent_id=agent.id,
            role="assistant",
            content=answer,
            query_mode=plan["query_mode"],
            citations=citations,
            api_mode=body.api_mode,
        )
        conversation.corpora_json = list(body.corpora)
        conversation.api_mode = body.api_mode
        session.commit()
        store_cached_response(
            session,
            agent_id=agent.id,
            request_hash=cache_key,
            answer_text=answer,
            query_mode=plan["query_mode"],
            citations=citations,
        )
        return ChatResponse(
            answer=answer,
            query_mode=plan["query_mode"],
            citations=citations,
            conversation_id=conversation.id,
            agent_id=agent.id,
            cached=False,
        )

    @app.post("/agent/chat/stream")
    async def agent_chat_stream(
        body: ChatRequest,
        request: Request,
        session: Session = Depends(get_session),
    ) -> StreamingResponse:
        top_k = resolve_query_top_k(session, body.top_k)
        agent = get_agent(session, body.agent_id)
        conversation = session.get(AgentConversationRecord, body.conversation_id) if body.conversation_id else None
        if body.conversation_id and conversation is None:
            raise HTTPException(404, "conversation not found")
        if conversation is not None and conversation.agent_id != agent.id:
            raise HTTPException(400, "conversation does not belong to the selected agent")
        if conversation is None:
            conversation = create_conversation(
                session,
                agent_id=agent.id,
                message=body.message,
                corpora=body.corpora,
                api_mode=body.api_mode,
            )
            session.commit()
            session.refresh(conversation)
        history = list_messages(session, conversation.id, limit=max(settings.app_agent_memory_window_messages * 2, 20))
        history_context = build_history_context(history, window_messages=settings.app_agent_memory_window_messages)
        cache_key = build_response_cache_key(
            agent=agent,
            history_context=history_context,
            message=body.message,
            corpora=body.corpora,
            api_mode=body.api_mode,
        )
        cached = lookup_cached_response(session, agent_id=agent.id, request_hash=cache_key)
        plan = None
        if cached is None:
            plan = await fetch_query_plan(
                build_query_message(message=body.message, history_context=history_context),
                body.corpora,
                top_k,
                request.state.trace_id,
            )
        connection = get_active_connection(session, "openai")

        def _encode(payload: dict) -> str:
            return f"data: {json.dumps(payload)}\n\n"

        def _stream():
            answer_parts: list[str] = []
            yield _encode(
                {
                    "type": "start",
                    "api_mode": body.api_mode,
                    "query_mode": cached.query_mode if cached is not None else plan["query_mode"],
                    "citations": cached.citations_json if cached is not None else plan.get("citations", []),
                    "conversation_id": conversation.id,
                    "agent_id": agent.id,
                    "cached": cached is not None,
                }
            )
            if cached is not None:
                yield _encode({"type": "delta", "delta": cached.answer_text})
                answer_parts.append(cached.answer_text)
            elif plan.get("direct_answer"):
                yield _encode({"type": "delta", "delta": plan["direct_answer"]})
                answer_parts.append(plan["direct_answer"])
            else:
                for delta in stream_answer(
                    build_answer_prompt(
                        agent_name=agent.name,
                        system_prompt=agent.system_prompt,
                        query_prompt=plan["prompt"],
                        history_context=history_context,
                    ),
                    connection,
                    api_mode=body.api_mode,
                    system_prompt=agent.system_prompt,
                    model_id=agent.model_id,
                    temperature=agent.temperature,
                    max_tokens=agent.max_tokens,
                    trace_id=request.state.trace_id,
                    service="agent-ingress",
                ):
                    answer_parts.append(delta)
                    yield _encode({"type": "delta", "delta": delta})
            answer_text = "".join(answer_parts)
            citations = cached.citations_json if cached is not None else plan.get("citations", [])
            query_mode = cached.query_mode if cached is not None else plan["query_mode"]
            with SessionLocal() as stream_session:
                append_message(
                    stream_session,
                    conversation_id=conversation.id,
                    agent_id=agent.id,
                    role="user",
                    content=body.message,
                )
                append_message(
                    stream_session,
                    conversation_id=conversation.id,
                    agent_id=agent.id,
                    role="assistant",
                    content=answer_text,
                    query_mode=query_mode,
                    citations=citations,
                    api_mode=body.api_mode,
                )
                stream_conversation = stream_session.get(AgentConversationRecord, conversation.id)
                if stream_conversation is not None:
                    stream_conversation.corpora_json = list(body.corpora)
                    stream_conversation.api_mode = body.api_mode
                stream_session.commit()
                if cached is None:
                    store_cached_response(
                        stream_session,
                        agent_id=agent.id,
                        request_hash=cache_key,
                        answer_text=answer_text,
                        query_mode=query_mode,
                        citations=citations,
                    )
            yield _encode({"type": "done", "citations": citations, "conversation_id": conversation.id, "cached": cached is not None})

        return StreamingResponse(
            _stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return app


app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run(
        "ghostdash_api.agent_ingress:app",
        host="0.0.0.0",
        port=8001,
        reload=False,
        access_log=False,
        log_config=None,
    )


if __name__ == "__main__":
    run()
