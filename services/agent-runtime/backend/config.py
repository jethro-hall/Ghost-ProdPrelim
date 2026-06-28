"""
Agent Runtime — environment config and settings.
All credentials come from env vars only. Never hardcoded.
"""
from __future__ import annotations

import os
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Database
    db_url: str = "postgresql+psycopg://ghostdash:ghostdash@postgres:5432/ghostdash"

    # GPU / data layer
    rapids_url: str = "http://rapids-analytics:8010"
    odoo_url: str = ""
    odoo_db: str = ""
    odoo_user: str = ""
    odoo_password: str = ""

    # AWS / Bedrock
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None
    aws_default_region: str = "us-east-1"

    # External Data API (FDL-side analytics gateway). Server-side proxy only —
    # the API key never reaches the browser.
    external_data_api_url: str = "http://3.105.115.144:4110"
    external_data_api_key: str = ""
    external_data_api_timeout_seconds: float = 30.0
    external_data_api_max_rows: int = 5000

    # Runtime
    agent_runtime_sandbox_root: str = "/tmp/agent-runtime"
    agent_runtime_max_steps: int = 40
    agent_runtime_default_model: str = "us.anthropic.claude-opus-4-5"
    agent_runtime_verifier_model: str = "us.anthropic.claude-sonnet-4-5-20251101-v1:0"
    agent_runtime_max_output_bytes_for_model: int = 8192  # 8KB summary cap
    agent_runtime_python_timeout_seconds: int = 90
    agent_runtime_bash_timeout_seconds: int = 90

    # Service
    host: str = "0.0.0.0"
    port: int = 8200
    log_level: str = "info"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
