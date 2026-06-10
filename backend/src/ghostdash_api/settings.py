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
    app_docx_sidecar_url: str = 'http://docx-templater:8080'
    app_redis_url: str | None = None
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
    app_sub_agent_max_retries: int = 1
    app_sub_agent_retry_backoff_ms: int = 300
    app_working_memory_ttl_seconds: int = 1800
    app_qdrant_upsert_max_payload_bytes: int = 24 * 1024 * 1024
    app_qdrant_upsert_max_points: int = 128
    app_llm_request_timeout_seconds: float = 900.0
    # When True, /v1/responses may fall back to chat.completions on 504/upstream timeout (common on long
    # Business Strategist + sub-agent + Odoo runs under gateway limits).
    app_llm_responses_fallback_to_chat: bool = True
    # Sub-agent Worker LLM calls omit max_tokens in the UI; cap generation to keep latency bounded.
    app_sub_agent_max_output_tokens_default: int = 4096
    app_odoo_agentic_enabled: bool = True
    app_odoo_agentic_max_iterations: int = 8
    app_voice_ingress_secret: str | None = None
    elevenlabs_hubtiger_webhook_secret: str | None = None
    elevenlabs_shopify_webhook_secret: str | None = None
    app_voice_first_token_target_ms: int = 1500
    app_voice_max_output_tokens: int = 160
    app_voice_stream_guard_holdback_chars: int = 32
    app_voice_stt_provider: str = "deepgram_primary"
    app_voice_stt_endpointing_ms: int = 650
    app_voice_stt_max_endpointing_ms: int = 900
    app_voice_stt_min_utterance_chars: int = 2
    deepgram_api_key: str | None = None
    deepgram_model: str = "nova-2"
    hubtiger_mcp_url: str | None = None
    shopify_mcp_url: str | None = None
    shopify_mcp_health_timeout_ms: int = 4000
    shopify_mcp_timeout_ms: int = 15000
    hubtiger_proxy_url: str | None = None
    hubtiger_mcp_health_timeout_ms: int = 4000
    hubtiger_tool_access: str = "read_only"
    hubtiger_booking_auto_execute: bool = False
    hubtiger_read_timeout_ms: int = 6000
    hubtiger_customer_lookup_timeout_ms: int = 20000
    hubtiger_mutation_timeout_ms: int = 12000
    hubtiger_max_search_chars: int = 96
    hubtiger_max_rows: int = 25
    hubtiger_max_matches: int = 15
    hubtiger_max_field_chars: int = 512
    hubtiger_max_payload_chars: int = 12000
    hubtiger_enable_local_simple_llm: bool = True
    hubtiger_simple_llm_timeout_ms: int = 1800
    hubtiger_simple_llm_max_tokens: int = 24
    elevenlabs_api_key: str | None = None
    elevenlabs_default_voice_id: str | None = None
    elevenlabs_allowed_voice_ids: str | None = None
    elevenlabs_analysis_timeout_ms: int = 15000
    elevenlabs_convai_agent_id: str | None = None
    elevenlabs_test_timeout_ms: int = 120000
    hubtiger_elevenlabs_tool_dir: str | None = None
    app_operator_admin_key: str | None = None

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
