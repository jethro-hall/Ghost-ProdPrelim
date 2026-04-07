from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


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
    app_qdrant_collection: str = 'ghostdash_knowledge'
    app_default_chat_model: str = 'openai/gpt-5.4'
    app_default_embedding_model: str = 'openai/text-embedding-3-small'
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
    llama_cloud_api_key: str | None = None
    qdrant_api_key: str | None = None
    app_embedding_cache_enabled: bool = True
    app_embedding_cache_ttl_seconds: int = 60 * 60 * 24 * 30
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
