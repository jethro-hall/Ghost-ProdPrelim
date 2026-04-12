from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .models import (
    AgentConversationRecord,
    AgentMessageRecord,
    AgentProfileRecord,
    ChatResponseCacheRecord,
    CollectionRecord,
    DocumentRecord,
    DocumentVersionRecord,
    IngestionRunRecord,
    RetrievalArtifactRecord,
    RuntimeProfileCollectionRecord,
    RuntimeProfileRecord,
    WorkbookArtifactRecord,
    WorkbookRowRecord,
    WorkbookSheetRecord,
    WorkbookTableRecord,
)
from .qdrant_store import count_corpus_vectors, delete_corpus_vectors, delete_document_vectors
from .settings import get_settings, should_backfill_default_embedding_model

settings = get_settings()


def normalize_collection_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(value).strip().lower()).strip("-")
    if not slug:
        raise ValueError("collection slug cannot be empty")
    return slug[:128]


def normalize_collection_name(value: str | None, *, fallback_slug: str) -> str:
    name = str(value or "").strip()
    if not name:
        name = fallback_slug.replace("-", " ").title()
    return name[:128]


def list_collections(session: Session) -> list[CollectionRecord]:
    return list(session.scalars(select(CollectionRecord).order_by(CollectionRecord.slug.asc())))


def get_collection(session: Session, collection_id: str) -> CollectionRecord:
    record = session.get(CollectionRecord, collection_id)
    if record is None:
        raise ValueError(f"collection {collection_id} not found")
    return record


def get_collection_by_slug(session: Session, slug: str) -> CollectionRecord | None:
    return session.scalar(select(CollectionRecord).where(CollectionRecord.slug == normalize_collection_slug(slug)))


def ensure_collection_record(
    session: Session,
    *,
    slug: str,
    name: str | None = None,
    description: str | None = None,
    embedding_model_id: str | None = None,
) -> CollectionRecord:
    normalized_slug = normalize_collection_slug(slug)
    record = get_collection_by_slug(session, normalized_slug)
    if record is None:
        record = CollectionRecord(
            slug=normalized_slug,
            name=normalize_collection_name(name, fallback_slug=normalized_slug),
            description=description,
            embedding_model_id=embedding_model_id,
        )
        session.add(record)
        session.flush()
    elif embedding_model_id and not str(record.embedding_model_id or "").strip():
        record.embedding_model_id = embedding_model_id
    return record


def get_runtime_profile_collection_slugs(session: Session, runtime_profile: RuntimeProfileRecord) -> list[str]:
    rows = list(
        session.execute(
            select(CollectionRecord.slug)
            .join(RuntimeProfileCollectionRecord, RuntimeProfileCollectionRecord.collection_id == CollectionRecord.id)
            .where(RuntimeProfileCollectionRecord.runtime_profile_id == runtime_profile.id)
            .order_by(RuntimeProfileCollectionRecord.position.asc(), RuntimeProfileCollectionRecord.created_at.asc())
        )
    )
    return [str(slug) for (slug,) in rows]


def sync_runtime_profile_collection_bindings(
    session: Session,
    runtime_profile: RuntimeProfileRecord,
    collection_slugs: list[str],
    *,
    create_missing: bool = False,
) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in collection_slugs:
        slug = normalize_collection_slug(value)
        if slug in seen:
            continue
        record = get_collection_by_slug(session, slug)
        if record is None and create_missing:
            record = ensure_collection_record(session, slug=slug, name=slug)
        if record is None:
            raise ValueError(f"collection '{slug}' does not exist")
        normalized.append(slug)
        seen.add(slug)

    existing = list(
        session.scalars(
            select(RuntimeProfileCollectionRecord).where(
                RuntimeProfileCollectionRecord.runtime_profile_id == runtime_profile.id
            )
        )
    )
    existing_by_collection: dict[str, RuntimeProfileCollectionRecord] = {}
    for row in existing:
        collection = session.get(CollectionRecord, row.collection_id)
        if collection is not None:
            existing_by_collection[collection.slug] = row

    for row in existing:
        collection = session.get(CollectionRecord, row.collection_id)
        if collection is None or collection.slug not in seen:
            session.delete(row)

    for position, slug in enumerate(normalized):
        row = existing_by_collection.get(slug)
        record = get_collection_by_slug(session, slug)
        if record is None:
            continue
        if row is None:
            session.add(
                RuntimeProfileCollectionRecord(
                    runtime_profile_id=runtime_profile.id,
                    collection_id=record.id,
                    position=position,
                )
            )
        else:
            row.position = position

    kb_config = dict(runtime_profile.kb_config_json or {})
    kb_config["default_corpora"] = list(normalized)
    runtime_profile.kb_config_json = kb_config
    session.flush()
    return normalized


def hydrate_runtime_profile_collection_bindings(session: Session, runtime_profile: RuntimeProfileRecord) -> list[str]:
    attached = get_runtime_profile_collection_slugs(session, runtime_profile)
    if attached:
        kb_config = dict(runtime_profile.kb_config_json or {})
        kb_config["default_corpora"] = list(attached)
        runtime_profile.kb_config_json = kb_config
        return attached

    kb_config = dict(runtime_profile.kb_config_json or {})
    defaults = [str(value).strip() for value in kb_config.get("default_corpora", []) if str(value).strip()]
    if not defaults:
        default_collection = ensure_collection_record(
            session,
            slug=settings.app_default_corpus,
            name=settings.app_default_corpus,
            embedding_model_id=kb_config.get("embedding_model_id") or settings.app_default_embedding_model,
        )
        defaults = [default_collection.slug]
    return sync_runtime_profile_collection_bindings(session, runtime_profile, defaults, create_missing=True)


def _normalize_default_embedding_metadata(session: Session) -> set[str]:
    target_slugs = {normalize_collection_slug(settings.app_default_corpus)}
    default_profile = session.scalar(select(RuntimeProfileRecord).where(RuntimeProfileRecord.is_default.is_(True)))
    if default_profile is not None:
        kb_config = dict(default_profile.kb_config_json or {})
        if should_backfill_default_embedding_model(kb_config.get("embedding_model_id")):
            kb_config["embedding_model_id"] = settings.app_default_embedding_model
            default_profile.kb_config_json = kb_config
        target_slugs.update(
            normalize_collection_slug(value)
            for value in kb_config.get("default_corpora", [])
            if str(value).strip()
        )
    return target_slugs


def backfill_collection_registry(session: Session) -> None:
    corpus_values: set[str] = {normalize_collection_slug(settings.app_default_corpus)}

    for corpus in session.scalars(select(DocumentRecord.corpus).distinct()):
        if corpus:
            corpus_values.add(normalize_collection_slug(str(corpus)))
    for corpus in session.scalars(select(IngestionRunRecord.corpus).distinct()):
        if corpus:
            corpus_values.add(normalize_collection_slug(str(corpus)))
    for corpus in session.scalars(select(RetrievalArtifactRecord.corpus).distinct()):
        if corpus:
            corpus_values.add(normalize_collection_slug(str(corpus)))

    for profile in session.scalars(select(RuntimeProfileRecord)):
        kb_config = dict(profile.kb_config_json or {})
        for corpus in kb_config.get("default_corpora", []):
            if str(corpus).strip():
                corpus_values.add(normalize_collection_slug(str(corpus)))

    for conversation in session.scalars(select(AgentConversationRecord)):
        for corpus in conversation.corpora_json or []:
            if str(corpus).strip():
                corpus_values.add(normalize_collection_slug(str(corpus)))

    target_slugs = _normalize_default_embedding_metadata(session)

    for slug in sorted(corpus_values):
        ensure_collection_record(session, slug=slug, name=slug, embedding_model_id=settings.app_default_embedding_model)

    for slug in target_slugs:
        record = get_collection_by_slug(session, slug)
        if record is None:
            continue
        if should_backfill_default_embedding_model(record.embedding_model_id):
            record.embedding_model_id = settings.app_default_embedding_model

    for profile in session.scalars(select(RuntimeProfileRecord)):
        hydrate_runtime_profile_collection_bindings(session, profile)

    session.commit()


def _count_workbook_records_for_document_ids(session: Session, document_ids: list[str]) -> tuple[int, int, int, int]:
    if not document_ids:
        return (0, 0, 0, 0)
    workbook_ids = list(
        session.scalars(select(WorkbookArtifactRecord.id).where(WorkbookArtifactRecord.document_id.in_(document_ids)))
    )
    sheet_ids = list(
        session.scalars(select(WorkbookSheetRecord.id).where(WorkbookSheetRecord.workbook_artifact_id.in_(workbook_ids)))
    ) if workbook_ids else []
    table_ids = list(
        session.scalars(select(WorkbookTableRecord.id).where(WorkbookTableRecord.workbook_sheet_id.in_(sheet_ids)))
    ) if sheet_ids else []
    row_count = int(
        session.scalar(select(func.count(WorkbookRowRecord.id)).where(WorkbookRowRecord.workbook_table_id.in_(table_ids or [""])))
        or 0
    )
    return (len(workbook_ids), len(sheet_ids), len(table_ids), row_count)


def _clear_document_state(session: Session, document_id: str) -> None:
    workbook_ids = list(
        session.scalars(
            select(WorkbookArtifactRecord.id).where(WorkbookArtifactRecord.document_id == document_id)
        )
    )
    sheet_ids = list(
        session.scalars(
            select(WorkbookSheetRecord.id).where(WorkbookSheetRecord.workbook_artifact_id.in_(workbook_ids))
        )
    ) if workbook_ids else []
    table_ids = list(
        session.scalars(
            select(WorkbookTableRecord.id).where(WorkbookTableRecord.workbook_sheet_id.in_(sheet_ids))
        )
    ) if sheet_ids else []
    if table_ids:
        session.execute(delete(WorkbookRowRecord).where(WorkbookRowRecord.workbook_table_id.in_(table_ids)))
        session.execute(delete(WorkbookTableRecord).where(WorkbookTableRecord.id.in_(table_ids)))
    if sheet_ids:
        session.execute(delete(WorkbookSheetRecord).where(WorkbookSheetRecord.id.in_(sheet_ids)))
    if workbook_ids:
        session.execute(delete(WorkbookArtifactRecord).where(WorkbookArtifactRecord.id.in_(workbook_ids)))
    session.execute(delete(RetrievalArtifactRecord).where(RetrievalArtifactRecord.document_id == document_id))


def _citations_reference_collection(citations: list[dict] | None, slug: str) -> bool:
    for citation in citations or []:
        corpus = str(citation.get("corpus") or "").strip()
        if not corpus:
            continue
        if normalize_collection_slug(corpus) == slug:
            return True
    return False


def collection_delete_impact(session: Session, collection: CollectionRecord) -> dict[str, Any]:
    slug = collection.slug
    document_ids = list(session.scalars(select(DocumentRecord.id).where(DocumentRecord.corpus == slug)))
    workbook_artifacts, workbook_sheets, workbook_tables, workbook_rows = _count_workbook_records_for_document_ids(
        session, document_ids
    )
    attached_runtime_profile_ids = list(
        session.scalars(
            select(RuntimeProfileCollectionRecord.runtime_profile_id).where(
                RuntimeProfileCollectionRecord.collection_id == collection.id
            )
        )
    )
    attached_agent_ids = list(
        session.scalars(
            select(AgentProfileRecord.id).where(AgentProfileRecord.runtime_profile_id.in_(attached_runtime_profile_ids or [""]))
        )
    )

    conversations = list(session.scalars(select(AgentConversationRecord)))
    conversation_ids: set[str] = {
        conversation.id
        for conversation in conversations
        if slug in [normalize_collection_slug(value) for value in (conversation.corpora_json or []) if str(value).strip()]
    }
    messages = list(session.scalars(select(AgentMessageRecord)))
    for message in messages:
        if _citations_reference_collection(message.citations_json or [], slug):
            conversation_ids.add(message.conversation_id)
    cache_rows = list(session.scalars(select(ChatResponseCacheRecord)))
    cache_entry_ids = {
        row.id
        for row in cache_rows
        if row.agent_id in attached_agent_ids or _citations_reference_collection(row.citations_json or [], slug)
    }

    return {
        "documents": len(document_ids),
        "document_versions": int(
            session.scalar(select(func.count(DocumentVersionRecord.id)).where(DocumentVersionRecord.document_id.in_(document_ids or [""])))
            or 0
        ),
        "retrieval_artifacts": int(
            session.scalar(
                select(func.count(RetrievalArtifactRecord.id)).where(RetrievalArtifactRecord.document_id.in_(document_ids or [""]))
            )
            or 0
        ),
        "workbook_artifacts": workbook_artifacts,
        "workbook_sheets": workbook_sheets,
        "workbook_tables": workbook_tables,
        "workbook_rows": workbook_rows,
        "ingestion_runs": int(
            session.scalar(select(func.count(IngestionRunRecord.id)).where(IngestionRunRecord.corpus == slug)) or 0
        ),
        "active_runs": int(
            session.scalar(
                select(func.count(IngestionRunRecord.id)).where(
                    IngestionRunRecord.corpus == slug,
                    IngestionRunRecord.status.in_(("pending", "running")),
                )
            )
            or 0
        ),
        "runtime_profiles": len(attached_runtime_profile_ids),
        "agents": len(attached_agent_ids),
        "conversations": len(conversation_ids),
        "messages": int(
            session.scalar(select(func.count(AgentMessageRecord.id)).where(AgentMessageRecord.conversation_id.in_(conversation_ids or [""])))
            or 0
        ),
        "cache_entries": len(cache_entry_ids),
        "vector_points": count_corpus_vectors(slug),
        "upload_paths": sorted({str(settings.upload_dir / slug)}),
    }


def _remove_path(path: str) -> None:
    target = Path(path)
    if not target.exists():
        return
    if target.is_dir():
        shutil.rmtree(target, ignore_errors=True)
    else:
        target.unlink(missing_ok=True)


def delete_collection_and_storage(session: Session, collection: CollectionRecord) -> dict[str, Any]:
    impact = collection_delete_impact(session, collection)
    if impact["active_runs"]:
        raise ValueError("collection has active ingestion runs and cannot be deleted")

    slug = collection.slug
    document_rows = list(session.scalars(select(DocumentRecord).where(DocumentRecord.corpus == slug)))
    document_ids = [document.id for document in document_rows]

    attached_profile_ids = list(
        session.scalars(
            select(RuntimeProfileCollectionRecord.runtime_profile_id).where(
                RuntimeProfileCollectionRecord.collection_id == collection.id
            )
        )
    )
    attached_profiles = [session.get(RuntimeProfileRecord, profile_id) for profile_id in attached_profile_ids]
    attached_profiles = [profile for profile in attached_profiles if profile is not None]

    attached_agent_ids = list(
        session.scalars(
            select(AgentProfileRecord.id).where(AgentProfileRecord.runtime_profile_id.in_(attached_profile_ids or [""]))
        )
    )

    conversation_ids: set[str] = set()
    conversations = list(session.scalars(select(AgentConversationRecord)))
    for conversation in conversations:
        corpora = [normalize_collection_slug(value) for value in (conversation.corpora_json or []) if str(value).strip()]
        if slug in corpora:
            conversation_ids.add(conversation.id)
            continue
    for message in session.scalars(select(AgentMessageRecord)):
        if _citations_reference_collection(message.citations_json or [], slug):
            conversation_ids.add(message.conversation_id)

    for conversation_id in conversation_ids:
        session.execute(delete(AgentMessageRecord).where(AgentMessageRecord.conversation_id == conversation_id))
    if conversation_ids:
        session.execute(delete(AgentConversationRecord).where(AgentConversationRecord.id.in_(conversation_ids)))

    cache_rows = list(session.scalars(select(ChatResponseCacheRecord)))
    for row in cache_rows:
        if row.agent_id in attached_agent_ids or _citations_reference_collection(row.citations_json or [], slug):
            session.delete(row)

    for document in document_rows:
        version_paths = list(
            session.scalars(
                select(DocumentVersionRecord.storage_path).where(DocumentVersionRecord.document_id == document.id)
            )
        )
        delete_document_vectors(document.id)
        _clear_document_state(session, document.id)
        session.execute(delete(DocumentVersionRecord).where(DocumentVersionRecord.document_id == document.id))
        for path in {document.source_path, *version_paths}:
            if path:
                _remove_path(str(path))
        session.delete(document)

    # Extra safety in case payload-only points remain without a document row.
    delete_corpus_vectors(slug)

    session.execute(delete(IngestionRunRecord).where(IngestionRunRecord.corpus == slug))
    session.execute(
        delete(RuntimeProfileCollectionRecord).where(RuntimeProfileCollectionRecord.collection_id == collection.id)
    )

    for profile in attached_profiles:
        remaining = get_runtime_profile_collection_slugs(session, profile)
        kb_config = dict(profile.kb_config_json or {})
        kb_config["default_corpora"] = list(remaining)
        profile.kb_config_json = kb_config

    session.delete(collection)
    session.flush()
    _remove_path(str(settings.upload_dir / slug))
    session.commit()
    return impact
