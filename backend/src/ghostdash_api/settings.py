from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_EMBEDDING_BASE_URL = "http://tei-embeddings:80/v1"
DEFAULT_EMBEDDING_MODEL = "openai/intfloat/multilingual-e5-large-instruct"
DEFAULT_QDRANT_COLLECTION = "ghostdash_knowledge_e5_v1"
DEFAULT_QDRANT_VECTOR_SIZE = 1024
LEGACY_DEFAULT_EMBEDDING_MODELS = frozenset(
    {
        "openai/text-embedding-3-small",
        "text-embedding-3-small",
    }
)


def should_backfill_default_embedding_model(value: str | None) -> bool:
    candidate = str(value or "").strip()
    return not candidate or candidate in LEGACY_DEFAULT_EMBEDDING_MODELS


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')

    app_db_url: str = 'postgresql+psycopg://ghostdash:ghostdash@postgres:5432/ghostdash'
    app_data_dir: str = '/data'
    app_upload_dir: str = '/data/uploads'
    app_default_corpus: str = 'default'
    app_default_policy_lane: str = 'local'
    app_control_api_base_url: str = 'http://control-api:8000'
    app_agent_ingress_base_url: str = 'http://agent-ingress:8001'
    app_workflow_runtime_url: str = 'http://workflow-runtime:8100'
    app_qdrant_url: str = 'http://qdrant:6333'
    app_qdrant_collection: str = DEFAULT_QDRANT_COLLECTION
    app_qdrant_vector_size: int = DEFAULT_QDRANT_VECTOR_SIZE
    app_default_chat_model: str = 'openai/llama31-8b'
    app_default_embedding_model: str = DEFAULT_EMBEDDING_MODEL
    app_chunk_size: int = 800
    app_chunk_overlap: int = 120
    app_pdf_chunk_size: int = 900
    app_pdf_chunk_overlap: int = 120
    app_pdf_sentence_window: int = 2
    app_pdf_top_k: int = 6
    app_pdf_parse_lane_policy: str = 'auto'
    app_llamaparse_tier: str = 'agentic'

    openai_api_key: str | None = None
    openai_base_url: str = 'https://api.openai.com/v1'
    openai_embedding_api_key: str | None = None
    openai_embedding_base_url: str = DEFAULT_EMBEDDING_BASE_URL
    llama_cloud_api_key: str | None = None
    qdrant_api_key: str | None = None
    app_embedding_cache_enabled: bool = True
    app_embedding_cache_ttl_seconds: int = 60 * 60 * 24 * 30
    app_embedding_batch_size: int = 8
    app_chat_response_cache_enabled: bool = True
    app_chat_response_cache_ttl_seconds: int = 60 * 60 * 24 * 7
    app_agent_memory_window_messages: int = 8
    app_qdrant_upsert_max_payload_bytes: int = 24 * 1024 * 1024
    app_qdrant_upsert_max_points: int = 128

    @property
    def db_path(self) -> Path:
        prefix = 'sqlite:///'
        if self.app_db_url.startswith(prefix):
            return Path(self.app_db_url.removeprefix(prefix))
        return Path('/data/app/ghostdash.db')

    @property
    def data_dir(self) -> Path:
        return Path(self.app_data_dir)

    @property
    def upload_dir(self) -> Path:
        return Path(self.app_upload_dir)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
