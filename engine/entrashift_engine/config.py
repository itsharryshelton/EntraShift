"""Engine settings.

Two layers of configuration:

    * **Static settings** (this module) — where the control plane lives, which
      Queue to pull, which secrets provider to use, and safety floors. Sourced
      from environment variables / ``.env`` (see ``.env.example``). These change
      only on redeploy.
    * **Dynamic config** (``contracts.EngineConfig``) — concurrency caps, poll
      interval, batch sizes, the ``paused`` flag — fetched at runtime from
      ``GET /api/vm/config`` and editable by an engineer in the UI Settings
      screen. The control plane is authoritative for these.

Nothing secret is stored here; credentials come from the secrets provider.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Static engine settings loaded from the environment / ``.env``."""

    model_config = SettingsConfigDict(
        env_prefix="ENTRASHIFT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Control plane (Cloudflare Worker) ---------------------------------
    # Base URL of the Worker, e.g. https://entrashift.example.com
    control_plane_base_url: str = Field(default="https://entrashift.example.com")

    # --- Cloudflare Queues HTTP pull ---------------------------------------
    # Account id + queue id identify the pull endpoint; the scoped API token
    # comes from the secrets provider, never from here.
    cf_account_id: str = Field(default="")
    cf_queue_id: str = Field(default="")
    # How many messages to pull per batch (engine processes one at a time but
    # may pull a small batch). Keep low to respect the 10k ops/day free-tier cap.
    queue_pull_batch_size: int = Field(default=1, ge=1, le=10)
    # Visibility timeout requested on pull, in seconds. Must comfortably exceed
    # the longest single job step so a message is not redelivered mid-flight.
    queue_visibility_timeout_sec: int = Field(default=600, ge=30)

    # --- Secrets provider ---------------------------------------------------
    # 'keyvault' (production, managed identity) or 'env' (local dev).
    secrets_provider: str = Field(default="env")
    key_vault_url: str = Field(default="")
    secrets_cache_ttl_sec: int = Field(default=300, ge=0)

    # --- Poll / write discipline (free-tier safety) ------------------------
    # Absolute client-side floor between control-plane polls and progress
    # writes, regardless of what the server reports. Never below 30 s (SoW
    # §1.1). The effective interval is max(this, EngineConfig.minPollIntervalSec).
    poll_interval_floor_sec: int = Field(default=30, ge=30)
    # How often to re-fetch dynamic EngineConfig (to observe pause/unpause and
    # concurrency changes) while idle-polling for work.
    config_refresh_sec: int = Field(default=60, ge=30)
    # How often to flush the batched item-log while a job runs.
    item_log_flush_sec: int = Field(default=30, ge=10)
    item_log_flush_size: int = Field(default=100, ge=1)
    # How often the running job pushes a checkpoint + progress update.
    checkpoint_interval_sec: int = Field(default=30, ge=30)

    # --- HTTP client tuning -------------------------------------------------
    http_timeout_sec: float = Field(default=120.0, gt=0)
    # Max backoff ceiling for Graph retries (seconds).
    graph_backoff_max_sec: float = Field(default=300.0, gt=0)
    graph_max_retries: int = Field(default=8, ge=0)

    # --- Local logging ------------------------------------------------------
    log_dir: str = Field(default="./logs")
    log_file_max_bytes: int = Field(default=10_485_760, ge=1024)  # 10 MB
    log_file_backup_count: int = Field(default=10, ge=0)
    log_level: str = Field(default="INFO")


@lru_cache
def get_settings() -> Settings:
    """Cached settings singleton."""
    return Settings()
