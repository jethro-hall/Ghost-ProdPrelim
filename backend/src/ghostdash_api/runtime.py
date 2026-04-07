from __future__ import annotations

import json
from typing import Iterable

from openai import OpenAI
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import ConnectionRecord
from .settings import get_settings

settings = get_settings()


def seed_default_connections(session: Session) -> None:
    defaults = {
        'openai': {
            'label': 'OpenAI',
            'api_key': settings.openai_api_key,
            'base_url': settings.openai_base_url,
            'chat_model': settings.app_default_chat_model,
            'embedding_model': settings.app_default_embedding_model,
            'enabled': bool(settings.openai_api_key),
        },
        'anthropic': {
            'label': 'Anthropic',
            'api_key': None,
            'base_url': None,
            'chat_model': None,
            'embedding_model': None,
            'enabled': False,
        },
    }
    for provider, payload in defaults.items():
        existing = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == provider))
        if existing:
            if provider == 'openai' and settings.openai_api_key and not existing.api_key:
                existing.api_key = settings.openai_api_key
                existing.enabled = True
                existing.chat_model = existing.chat_model or settings.app_default_chat_model
                existing.embedding_model = existing.embedding_model or settings.app_default_embedding_model
            continue
        session.add(ConnectionRecord(provider=provider, **payload))
    session.commit()


def list_connections(session: Session) -> list[ConnectionRecord]:
    return list(session.scalars(select(ConnectionRecord).order_by(ConnectionRecord.provider)))


def save_connection(session: Session, provider: str, **fields) -> ConnectionRecord:
    record = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == provider))
    if record is None:
        record = ConnectionRecord(provider=provider, label=fields.get('label') or provider.title())
        session.add(record)

    for key, value in fields.items():
        if key == 'api_key' and value in (None, ''):
            continue
        setattr(record, key, value)

    if provider == 'openai':
        record.chat_model = record.chat_model or settings.app_default_chat_model
        record.embedding_model = record.embedding_model or settings.app_default_embedding_model

    session.commit()
    session.refresh(record)
    return record


def get_active_connection(session: Session, provider: str = 'openai') -> ConnectionRecord:
    connection = session.scalar(select(ConnectionRecord).where(ConnectionRecord.provider == provider))
    if connection is None:
        raise ValueError(f'No connection record exists for {provider}')
    return connection


def _provider_headers(connection: ConnectionRecord) -> dict[str, str]:
    api_key = connection.api_key or settings.openai_api_key
    if connection.provider == 'openai' and api_key:
        return {
            'X-LlamaStack-Provider-Data': json.dumps({'openai_api_key': api_key}),
        }
    return {}


def get_runtime_client(connection: ConnectionRecord) -> OpenAI:
    return OpenAI(
        base_url=f"{settings.app_llamastack_base_url.rstrip('/')}/v1",
        api_key='llama-stack',
        default_headers=_provider_headers(connection),
    )


def embed_texts(texts: Iterable[str], connection: ConnectionRecord) -> list[list[float]]:
    texts = list(texts)
    if not texts:
        return []
    client = get_runtime_client(connection)
    model = connection.embedding_model or settings.app_default_embedding_model
    response = client.embeddings.create(model=model, input=texts)
    return [item.embedding for item in response.data]


def complete_answer(prompt: str, connection: ConnectionRecord) -> str:
    client = get_runtime_client(connection)
    model = connection.chat_model or settings.app_default_chat_model
    response = client.chat.completions.create(
        model=model,
        messages=[
            {
                'role': 'system',
                'content': (
                    'You answer using retrieved knowledge only. Always ground the answer '
                    'in the provided context and say when the context is insufficient.'
                ),
            },
            {'role': 'user', 'content': prompt},
        ],
    )
    choice = response.choices[0].message.content
    return (choice or '').strip()
