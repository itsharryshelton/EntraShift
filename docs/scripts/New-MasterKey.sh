#!/usr/bin/env bash
#
# EntraShift — generate the AES-256-GCM envelope master key.
#
# This produces a base64-encoded 32-byte (256-bit) random key suitable for use as the
# MASTER_ENCRYPTION_KEY Cloudflare Worker Secret. Tenant client secrets and temporary
# provisioning passwords are AES-256-GCM encrypted under this key in the Worker before
# only the ciphertext is written to D1 (SoW Phase 0, envelope encryption).
#
# SECURITY NOTES (read before running):
#   * The key is printed to STDOUT. Treat the output as a live credential: do NOT paste it
#     into chat, tickets, screen shares, or commit it to source control.
#   * Prefer piping the key straight into `wrangler secret put` (see below) so it never
#     lands on disk or in your shell history.
#   * There is exactly ONE master key per deployment. If it is lost, every stored tenant
#     secret becomes undecryptable and must be re-entered. If it is rotated, all ciphertext
#     in D1 must be re-encrypted (re-enter tenant secrets via the UI). See docs/security.md.
#   * This is PROTOTYPE tooling pending the IT/security review gate (SoW §5). A qualified
#     engineer must review key custody before any production tenant is connected.
#
# Usage:
#   ./New-MasterKey.sh                 # print a fresh key to STDOUT
#   ./New-MasterKey.sh | tr -d '\n' | wrangler secret put MASTER_ENCRYPTION_KEY
#
set -euo pipefail

# 32 bytes = 256 bits. `openssl rand -base64 32` emits standard base64 (44 chars incl. '=').
if command -v openssl >/dev/null 2>&1; then
  openssl rand -base64 32
else
  # Fallback: read 32 bytes from the OS CSPRNG and base64-encode them.
  head -c 32 /dev/urandom | base64
fi
