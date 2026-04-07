"""Background ingestion worker: poll tasks, parse documents, embed via Llama Stack, index Qdrant."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import SessionLocal, init_db
from .ingest import extract_text_cloud, extract_text_local
from .models import DocumentRecord, TaskRecord
from .qdrant_store import delete_document_vectors, upsert_chunks
from .runtime import embed_texts, get_active_connection
from .settings import get_settings

settings = get_settings()

SYNC_STEPS = ('queued', 'scan_documents', 'parse_embed', 'finalize')


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(n, start + chunk_size)
        chunks.append(text[start:end])
        if end >= n:
            break
        start = max(0, end - overlap)
    return chunks


def _set_task_step(task: TaskRecord, step: str, progress: float) -> None:
    task.current_step = step
    task.progress = progress


def process_full_sync(session: Session, task: TaskRecord) -> None:
    corpus = (task.payload or {}).get('corpus') or settings.app_default_corpus
    _set_task_step(task, 'scan_documents', 0.1)
    session.commit()

    docs = list(
        session.scalars(
            select(DocumentRecord).where(
                DocumentRecord.corpus == corpus,
                DocumentRecord.status.in_(('uploaded', 'error', 'indexed')),
            )
        )
    )
    if not docs:
        _set_task_step(task, 'finalize', 1.0)
        task.result_json = json.dumps({'documents_processed': 0})
        return

    connection = get_active_connection(session, 'openai')
    total = len(docs)

    for i, doc in enumerate(docs):
        path = Path(doc.source_path)
        if not path.is_file():
            doc.status = 'error'
            doc.error_message = 'missing file on disk'
            session.commit()
            continue

        lane = doc.policy_lane or settings.app_default_policy_lane
        try:
            if lane == 'cloud':
                text, parse_lane = extract_text_cloud(path, settings.app_llamaparse_tier)
            else:
                text, parse_lane = extract_text_local(path)
        except Exception as e:
            doc.status = 'error'
            doc.error_message = str(e)[:2000]
            doc.parse_lane = lane
            session.commit()
            continue

        doc.parse_lane = parse_lane
        doc.content_hash = hashlib.sha256(text.encode('utf-8', errors='replace')).hexdigest()

        chunks = chunk_text(text, settings.app_chunk_size, settings.app_chunk_overlap)
        if not chunks:
            doc.status = 'error'
            doc.error_message = 'no text extracted'
            session.commit()
            continue

        vectors = embed_texts(chunks, connection)
        delete_document_vectors(doc.id)
        upsert_chunks(
            document_id=doc.id,
            filename=doc.filename,
            corpus=doc.corpus,
            source_path=doc.source_path,
            vectors=vectors,
            texts=chunks,
        )
        doc.status = 'indexed'
        doc.error_message = None
        session.commit()

        frac = 0.1 + 0.85 * ((i + 1) / total)
        _set_task_step(task, 'parse_embed', min(frac, 0.95))
        session.commit()

    _set_task_step(task, 'finalize', 1.0)
    task.result_json = json.dumps({'documents_processed': total})
    session.commit()


def process_task(session: Session, task: TaskRecord) -> None:
    if task.task_type == 'full_sync':
        process_full_sync(session, task)
    else:
        raise ValueError(f'unknown task_type {task.task_type}')


def tick() -> None:
    with SessionLocal() as session:
        task = session.scalar(
            select(TaskRecord)
            .where(TaskRecord.status == 'pending')
            .order_by(TaskRecord.created_at)
            .limit(1)
        )
        if task is None:
            return
        task.status = 'running'
        _set_task_step(task, 'scan_documents', 0.05)
        session.commit()
        try:
            process_task(session, task)
            task.status = 'completed'
        except Exception as e:
            task.status = 'failed'
            task.error_message = str(e)[:2000]
        session.commit()


def run() -> None:
    init_db()
    from .runtime import seed_default_connections

    with SessionLocal() as s:
        seed_default_connections(s)
    while True:
        tick()
        time.sleep(settings.app_sync_poll_interval_seconds)


if __name__ == '__main__':
    run()
