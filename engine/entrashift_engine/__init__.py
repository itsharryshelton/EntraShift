"""EntraShift migration engine.

Persistent Python worker service that runs on an Azure VM. It pulls one
user+workload job at a time from Cloudflare Queues, requests short-lived
Microsoft Graph access tokens from the Cloudflare Worker control plane, and
performs the Exchange / OneDrive data movement — reporting all state back to
the control plane over D1-backed ``/api/vm/*`` endpoints.

Security posture (see ``scopeofwork.md`` §0/§4):
    * The engine NEVER holds long-lived tenant client secrets. Those live only
      in the Worker (AES-256-GCM envelope-encrypted in D1). The engine only
      ever receives short-lived Graph access tokens.
    * The engine's own credentials (Cloudflare Access service token + Queue
      pull API token) come from Azure Key Vault via managed identity.
"""

__version__ = "0.1.0"
