"""Microsoft Graph access layer (raw httpx — no SDK).

We use raw Graph HTTP so the engine controls throttling, batching, and
``Retry-After`` handling precisely (SoW Phase 4). This package holds the shared
client, the per-tenant/per-mailbox throttle governor, and the typed error
hierarchy that maps Graph failures onto the distinct job failure statuses.
"""
