"""FastAPI control plane for GhostDASH."""

from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from starlette.middleware.base import BaseHTTPMiddleware

from .database import SessionLocal, get_session, init_db
from .models import DocumentRecord, TaskRecord
from .qdrant_store import ensure_collection, search_vectors
from .runtime import (
    complete_answer,
    embed_texts,
    get_active_connection,
    list_connections,
    save_connection,
    seed_default_connections,
)
from .schemas import (
    ChatCitation,
    ChatRequest,
    ChatResponse,
    ConnectionPayload,
    ConnectionView,
    SyncRequest,
    TaskStepView,
    TaskView,
    UploadView,
)
from .settings import get_settings
from .telemetry import log_event
from .worker import SYNC_STEPS

settings = get_settings()


def _parse_traceparent(header: str | None) -> str | None:
    if not header:
        return None
    parts = header.strip().split('-')
    if len(parts) >= 4 and parts[0] == '00' and len(parts[1]) == 32:
        return parts[1]
    return None


class ObservabilityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        inherited = _parse_traceparent(request.headers.get('traceparent'))
        trace_id = inherited or uuid.uuid4().hex
        span_id = uuid.uuid4().hex[:16]
        request.state.trace_id = trace_id
        request.state.span_id = span_id
        start = time.time()
        status = 500
        err: str | None = None
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers['X-Trace-Id'] = trace_id
            return response
        except Exception as e:
            err = repr(e)
            status = 500
            raise
        finally:
            end = time.time()
            log_event(
                trace_id=trace_id,
                span_id=span_id,
                service='ghostdash-api',
                route=request.url.path,
                start_ts=start,
                end_ts=end,
                status=status,
                error=err,
            )


def _task_to_view(task: TaskRecord) -> TaskView:
    try:
        idx = SYNC_STEPS.index(task.current_step)
    except ValueError:
        idx = 0
    steps: list[TaskStepView] = []
    for s in SYNC_STEPS:
        si = SYNC_STEPS.index(s)
        steps.append(
            TaskStepView(
                id=s,
                label=s.replace('_', ' ').title(),
                done=si < idx or task.status == 'completed',
                active=(s == task.current_step and task.status == 'running'),
            )
        )
    return TaskView(
        id=task.id,
        task_type=task.task_type,
        status=task.status,
        current_step=task.current_step,
        progress=task.progress,
        error_message=task.error_message,
        steps=steps,
    )


def create_app() -> FastAPI:
    app = FastAPI(title='GhostDASH API', version='0.1.0')
    app.add_middleware(ObservabilityMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=['*'],
        allow_credentials=True,
        allow_methods=['*'],
        allow_headers=['*'],
    )

    @app.on_event('startup')
    def _startup() -> None:
        init_db()
        with SessionLocal() as session:
            seed_default_connections(session)
        ensure_collection()

    @app.get('/health')
    def health() -> dict[str, str]:
        return {'status': 'ok'}

    @app.get('/api/connections', response_model=list[ConnectionView])
    def api_list_connections(session: Session = Depends(get_session)) -> list[ConnectionView]:
        rows = list_connections(session)
        return [
            ConnectionView(
                id=r.id,
                provider=r.provider,
                label=r.label,
                base_url=r.base_url,
                chat_model=r.chat_model,
                embedding_model=r.embedding_model,
                enabled=r.enabled,
                api_key_hint=r.masked_api_key,
                has_api_key=bool(r.api_key),
            )
            for r in rows
        ]

    @app.post('/api/connections', response_model=ConnectionView)
    def api_save_connection(
        body: ConnectionPayload,
        session: Session = Depends(get_session),
    ) -> ConnectionView:
        rec = save_connection(
            session,
            body.provider,
            label=body.label or body.provider,
            api_key=body.api_key,
            base_url=body.base_url,
            chat_model=body.chat_model,
            embedding_model=body.embedding_model,
            enabled=body.enabled,
        )
        return ConnectionView(
            id=rec.id,
            provider=rec.provider,
            label=rec.label,
            base_url=rec.base_url,
            chat_model=rec.chat_model,
            embedding_model=rec.embedding_model,
            enabled=rec.enabled,
            api_key_hint=rec.masked_api_key,
            has_api_key=bool(rec.api_key),
        )

    @app.post('/api/upload', response_model=UploadView)
    async def api_upload(
        corpus: str | None = Form(None),
        policy_lane: str | None = Form(None),
        file: UploadFile = File(...),
        session: Session = Depends(get_session),
    ) -> UploadView:
        corp = corpus or settings.app_default_corpus
        lane = policy_lane or settings.app_default_policy_lane
        if lane not in ('local', 'cloud'):
            raise HTTPException(400, 'policy_lane must be local or cloud')
        raw = file.filename or 'upload'
        safe = re.sub(r'[^a-zA-Z0-9._-]+', '_', Path(raw).name)[:200]
        dest_dir = settings.upload_dir / corp
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / safe
        content = await file.read()
        dest.write_bytes(content)
        doc = DocumentRecord(
            corpus=corp,
            filename=safe,
            source_path=str(dest.resolve()),
            policy_lane=lane,
            status='uploaded',
        )
        session.add(doc)
        session.commit()
        session.refresh(doc)
        return UploadView(
            id=doc.id,
            corpus=doc.corpus,
            filename=doc.filename,
            policy_lane=doc.policy_lane,
            status=doc.status,
        )

    @app.post('/api/sync', response_model=TaskView)
    def api_sync(
        body: SyncRequest = SyncRequest(),
        session: Session = Depends(get_session),
    ) -> TaskView:
        corp = body.corpus or settings.app_default_corpus
        task = TaskRecord(
            task_type='full_sync',
            status='pending',
            current_step='queued',
            progress=0.0,
            payload_json=json.dumps({'corpus': corp}),
        )
        session.add(task)
        session.commit()
        session.refresh(task)
        return _task_to_view(task)

    @app.get('/api/tasks/{task_id}', response_model=TaskView)
    def api_task(task_id: str, session: Session = Depends(get_session)) -> TaskView:
        task = session.get(TaskRecord, task_id)
        if task is None:
            raise HTTPException(404, 'task not found')
        return _task_to_view(task)

    @app.post('/api/chat', response_model=ChatResponse)
    def api_chat(body: ChatRequest, session: Session = Depends(get_session)) -> ChatResponse:
        connection = get_active_connection(session, 'openai')
        qvec = embed_texts([body.message], connection)
        if not qvec:
            raise HTTPException(500, 'embedding failed')
        hits = search_vectors(qvec[0], body.corpora or [], body.top_k)
        if not hits:
            prompt = (
                f"User question: {body.message}\n\n"
                'No retrieved context was found in the knowledge base. '
                'Say that you have no matching documents.'
            )
            answer = complete_answer(prompt, connection)
            return ChatResponse(answer=answer, citations=[])

        ctx_parts: list[str] = []
        citations: list[ChatCitation] = []
        for h in hits:
            ctx_parts.append(f"---\nFile: {h['filename']}\n{h['text']}")
            citations.append(
                ChatCitation(
                    document_id=h['document_id'],
                    filename=h['filename'],
                    corpus=h['corpus'],
                    chunk_index=int(h['chunk_index']),
                    source_path=h['source_path'],
                )
            )
        prompt = (
            'Use ONLY the following context to answer. If insufficient, say so.\n\n'
            + '\n'.join(ctx_parts)
            + f"\n\nUser question: {body.message}"
        )
        answer = complete_answer(prompt, connection)
        return ChatResponse(answer=answer, citations=citations)

    return app


app = create_app()


def run() -> None:
    import uvicorn

    uvicorn.run('ghostdash_api.main:app', host='0.0.0.0', port=8000, reload=False)


if __name__ == '__main__':
    run()
