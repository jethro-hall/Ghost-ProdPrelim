from __future__ import annotations

import json
from typing import Any

from sqlalchemy import inspect, select, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import OperationalError, ProgrammingError

from .models import RuntimeProfileRecord
from .runtime_profiles import build_runtime_profile_from_legacy

RUNTIME_DEFAULTS_KEY = "chat_defaults"


def _normalize_json(value: Any, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return fallback
    return fallback


def _unique_profile_name(base_name: str, existing_names: set[str]) -> str:
    candidate = base_name
    suffix = 2
    while candidate in existing_names:
        candidate = f"{base_name} {suffix}"
        suffix += 1
    existing_names.add(candidate)
    return candidate


def _load_legacy_runtime_defaults(connection: Connection, table_names: set[str]) -> dict[str, Any]:
    if "runtime_defaults" not in table_names:
        return {}
    row = connection.execute(
        text("SELECT value_json FROM runtime_defaults WHERE key = :key"),
        {"key": RUNTIME_DEFAULTS_KEY},
    ).mappings().first()
    return _normalize_json(row["value_json"], {}) if row else {}


def _load_legacy_connection_models(
    connection: Connection,
    connection_columns: set[str],
) -> tuple[str | None, str | None]:
    if "chat_model" not in connection_columns and "embedding_model" not in connection_columns:
        return None, None
    row = connection.execute(
        text(
            "SELECT chat_model, embedding_model FROM connections "
            "WHERE provider = :provider ORDER BY created_at ASC LIMIT 1"
        ),
        {"provider": "openai"},
    ).mappings().first()
    if row is None:
        return None, None
    return row.get("chat_model"), row.get("embedding_model")


def _create_index_if_missing(engine: Engine, table_name: str, index_name: str, column_name: str) -> None:
    inspector = inspect(engine)
    if table_name not in inspector.get_table_names():
        return
    existing = {index["name"] for index in inspector.get_indexes(table_name)}
    if index_name in existing:
        return
    with engine.begin() as connection:
        try:
            connection.execute(text(f"CREATE INDEX IF NOT EXISTS {index_name} ON {table_name} ({column_name})"))
        except (OperationalError, ProgrammingError) as exc:
            message = str(exc).lower()
            if "already exists" not in message and "duplicate" not in message:
                raise


def _ensure_agent_runtime_profile_column(engine: Engine) -> None:
    inspector = inspect(engine)
    if "agent_profiles" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("agent_profiles")}
    if "runtime_profile_id" in columns:
        return
    with engine.begin() as connection:
        statement = (
            "ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS runtime_profile_id VARCHAR(64)"
            if engine.dialect.name == "postgresql"
            else "ALTER TABLE agent_profiles ADD COLUMN runtime_profile_id VARCHAR(64)"
        )
        try:
            connection.execute(text(statement))
        except (OperationalError, ProgrammingError) as exc:
            message = str(exc).lower()
            if "already exists" not in message and "duplicate column" not in message:
                raise


def _backfill_runtime_profiles(engine: Engine) -> None:
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "agent_profiles" not in table_names or "runtime_profiles" not in table_names:
        return

    agent_columns = {column["name"] for column in inspector.get_columns("agent_profiles")}
    legacy_agent_columns = {"system_prompt", "model_id", "temperature", "max_tokens", "tools_json"}
    if not (legacy_agent_columns & agent_columns):
        return
    connection_columns = {column["name"] for column in inspector.get_columns("connections")} if "connections" in table_names else set()

    with engine.begin() as connection:
        existing_names = set(connection.execute(select(RuntimeProfileRecord.name)).scalars())
        legacy_defaults = _load_legacy_runtime_defaults(connection, table_names)
        legacy_chat_model, legacy_embedding_model = _load_legacy_connection_models(connection, connection_columns)
        agent_rows = connection.execute(
            text(
                "SELECT id, name, is_default, runtime_profile_id, "
                "system_prompt, model_id, temperature, max_tokens, tools_json "
                "FROM agent_profiles"
            )
        ).mappings()

        default_profile_id: str | None = None
        for row in agent_rows:
            if row.get("runtime_profile_id"):
                if row.get("is_default"):
                    default_profile_id = str(row["runtime_profile_id"])
                continue

            payload = build_runtime_profile_from_legacy(
                agent_name=str(row["name"]),
                system_prompt=row.get("system_prompt"),
                model_id=row.get("model_id") or legacy_chat_model,
                temperature=row.get("temperature"),
                max_tokens=row.get("max_tokens"),
                tools=_normalize_json(row.get("tools_json"), []),
                chat_api_mode=legacy_defaults.get("chat_api_mode"),
                embedding_model_id=legacy_embedding_model,
                retrieval_defaults={
                    "default_top_k": legacy_defaults.get("pdf_top_k"),
                    "pdf_chunk_size": legacy_defaults.get("pdf_chunk_size"),
                    "pdf_chunk_overlap": legacy_defaults.get("pdf_chunk_overlap"),
                    "pdf_sentence_window": legacy_defaults.get("pdf_sentence_window"),
                    "pdf_parse_lane_policy": legacy_defaults.get("pdf_parse_lane_policy"),
                    "pdf_rerank_enabled": legacy_defaults.get("pdf_rerank_enabled", False),
                },
                is_default=bool(row.get("is_default")),
            )
            payload["name"] = _unique_profile_name(str(payload["name"]), existing_names)
            result = connection.execute(RuntimeProfileRecord.__table__.insert().values(**payload))
            runtime_profile_id = str(result.inserted_primary_key[0])
            connection.execute(
                text("UPDATE agent_profiles SET runtime_profile_id = :runtime_profile_id WHERE id = :agent_id"),
                {"runtime_profile_id": runtime_profile_id, "agent_id": row["id"]},
            )
            if row.get("is_default"):
                default_profile_id = runtime_profile_id

        if default_profile_id is None:
            default_profile_id = connection.execute(
                text(
                    "SELECT runtime_profile_id FROM agent_profiles "
                    "WHERE is_default = true AND runtime_profile_id IS NOT NULL "
                    "ORDER BY updated_at DESC LIMIT 1"
                )
            ).scalar_one_or_none()
        if default_profile_id is None:
            default_profile_id = connection.execute(select(RuntimeProfileRecord.id).limit(1)).scalar_one_or_none()

        if default_profile_id is not None:
            connection.execute(text("UPDATE runtime_profiles SET is_default = false"))
            connection.execute(
                text("UPDATE runtime_profiles SET is_default = true WHERE id = :runtime_profile_id"),
                {"runtime_profile_id": str(default_profile_id)},
            )


def _drop_legacy_runtime_sources(engine: Engine) -> None:
    if engine.dialect.name != "postgresql":
        return
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    if "agent_profiles" in table_names:
        agent_columns = {column["name"] for column in inspector.get_columns("agent_profiles")}
        for column_name in ("system_prompt", "model_id", "temperature", "max_tokens", "tools_json"):
            if column_name in agent_columns:
                with engine.begin() as connection:
                    connection.execute(text(f"ALTER TABLE agent_profiles DROP COLUMN IF EXISTS {column_name}"))
    if "connections" in table_names:
        connection_columns = {column["name"] for column in inspector.get_columns("connections")}
        for column_name in ("chat_model", "embedding_model"):
            if column_name in connection_columns:
                with engine.begin() as connection:
                    connection.execute(text(f"ALTER TABLE connections DROP COLUMN IF EXISTS {column_name}"))
    if "runtime_defaults" in table_names:
        with engine.begin() as connection:
            connection.execute(text("DROP TABLE IF EXISTS runtime_defaults"))


def run_startup_migrations(engine: Engine) -> None:
    _ensure_agent_runtime_profile_column(engine)
    _create_index_if_missing(engine, "agent_profiles", "ix_agent_profiles_runtime_profile_id", "runtime_profile_id")
    _backfill_runtime_profiles(engine)
    _drop_legacy_runtime_sources(engine)
