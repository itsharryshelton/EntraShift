"""Secrets provider abstraction.

The engine needs exactly two long-lived credentials, and by design it holds
**no tenant secrets** at all:

    * ``cf-access-client-id`` / ``cf-access-client-secret`` — the Cloudflare
      Access **service token** used to authenticate to the Worker ``/api/vm/*``
      endpoints (sent as ``CF-Access-Client-Id`` / ``CF-Access-Client-Secret``).
    * ``cf-queue-api-token`` — a Cloudflare API token scoped to *queue consume
      only*, used to pull job-dispatch messages directly from the Queues HTTP
      pull API (never through the Worker).

In production these live in **Azure Key Vault** and are read via the VM's
**managed identity** (no credential material on disk). For local development a
``.env`` / environment-variable fallback is provided.

SECURITY: values returned here are secrets. They are never logged (the logging
setup redacts them defensively) and never written to disk by the engine.
PROTOTYPE — the Key Vault wiring must be validated in the security review gate.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Optional

# Canonical secret names (Key Vault secret names must match, dashes only).
SECRET_ACCESS_CLIENT_ID = "cf-access-client-id"
SECRET_ACCESS_CLIENT_SECRET = "cf-access-client-secret"
SECRET_QUEUE_API_TOKEN = "cf-queue-api-token"

# Env-var fallback names (dev only). Dashes -> underscores, upper-cased.
_ENV_NAMES = {
    SECRET_ACCESS_CLIENT_ID: "CF_ACCESS_CLIENT_ID",
    SECRET_ACCESS_CLIENT_SECRET: "CF_ACCESS_CLIENT_SECRET",
    SECRET_QUEUE_API_TOKEN: "CF_QUEUE_API_TOKEN",
}


class SecretsProvider(ABC):
    """Reads named secrets. Implementations must never log secret values."""

    @abstractmethod
    async def get(self, name: str) -> str:
        """Return the secret value for ``name`` or raise ``KeyError``."""
        raise NotImplementedError


class EnvSecrets(SecretsProvider):
    """Local-dev fallback: read secrets from environment variables / ``.env``.

    NOT for production use — environment variables are visible to the process
    tree and can leak into crash dumps. Use ``KeyVaultSecrets`` on the VM.
    """

    async def get(self, name: str) -> str:
        env_name = _ENV_NAMES.get(name, name.replace("-", "_").upper())
        value = os.environ.get(env_name)
        if not value:
            raise KeyError(
                f"secret {name!r} not found (env var {env_name!r} is unset)"
            )
        return value


class KeyVaultSecrets(SecretsProvider):
    """Production provider: Azure Key Vault via managed identity.

    Uses ``azure-identity`` (``DefaultAzureCredential`` -> managed identity on
    the VM) and ``azure-keyvault-secrets``. These are optional dependencies so
    the engine can run in dev without the Azure SDK installed; they are imported
    lazily and a clear error is raised if missing.

    Secrets are cached in-process for ``cache_ttl_sec`` to avoid a Key Vault
    round-trip on every token request. Rotation is picked up within the TTL.
    """

    def __init__(self, vault_url: str, cache_ttl_sec: int = 300) -> None:
        self._vault_url = vault_url
        self._cache_ttl_sec = cache_ttl_sec
        self._client: Optional[object] = None
        self._cache: dict[str, tuple[float, str]] = {}

    def _ensure_client(self) -> object:
        if self._client is not None:
            return self._client
        try:
            from azure.identity import DefaultAzureCredential
            from azure.keyvault.secrets import SecretClient
        except ImportError as exc:  # pragma: no cover - depends on optional deps
            raise RuntimeError(
                "KeyVaultSecrets requires the 'azure' extra "
                "(pip install 'entrashift-engine[azure]')"
            ) from exc
        credential = DefaultAzureCredential()
        self._client = SecretClient(vault_url=self._vault_url, credential=credential)
        return self._client

    async def get(self, name: str) -> str:
        import time

        now = time.monotonic()
        cached = self._cache.get(name)
        if cached and (now - cached[0]) < self._cache_ttl_sec:
            return cached[1]

        client = self._ensure_client()
        # The Key Vault SDK is synchronous; run it off the event loop so we do
        # not block other in-flight Graph work.
        import asyncio

        secret = await asyncio.to_thread(client.get_secret, name)  # type: ignore[attr-defined]
        value = secret.value
        if not value:
            raise KeyError(f"secret {name!r} has no value in Key Vault")
        self._cache[name] = (now, value)
        return value


def build_secrets_provider(
    provider: str, vault_url: Optional[str], cache_ttl_sec: int
) -> SecretsProvider:
    """Factory: ``'keyvault'`` -> Key Vault, anything else -> env fallback."""
    if provider == "keyvault":
        if not vault_url:
            raise ValueError(
                "secrets provider 'keyvault' requires KEY_VAULT_URL to be set"
            )
        return KeyVaultSecrets(vault_url, cache_ttl_sec=cache_ttl_sec)
    return EnvSecrets()
