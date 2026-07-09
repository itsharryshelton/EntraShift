<#
.SYNOPSIS
    EntraShift — generate the AES-256-GCM envelope master key (base64, 32 bytes).

.DESCRIPTION
    Produces a base64-encoded 32-byte (256-bit) cryptographically-random key suitable for
    the MASTER_ENCRYPTION_KEY Cloudflare Worker Secret. Tenant client secrets and temporary
    provisioning passwords are AES-256-GCM encrypted under this key inside the Worker before
    only the ciphertext is written to D1 (SoW Phase 0, envelope encryption).

    The key is generated with System.Security.Cryptography.RandomNumberGenerator (a CSPRNG),
    NOT Get-Random.

.PARAMETER SetSecret
    If supplied, pipes the freshly generated key directly into
    `wrangler secret put MASTER_ENCRYPTION_KEY` so the plaintext never touches disk or the
    console. Requires wrangler to be installed and authenticated, and must be run from the
    worker/ directory (or pass -WorkerDir).

.PARAMETER WorkerDir
    Directory containing wrangler.jsonc. Only used with -SetSecret. Defaults to ../../worker
    relative to this script.

.EXAMPLE
    ./New-MasterKey.ps1
    # Prints a fresh base64 key to STDOUT.

.EXAMPLE
    ./New-MasterKey.ps1 -SetSecret
    # Generates the key and pipes it straight into `wrangler secret put MASTER_ENCRYPTION_KEY`.

.NOTES
    SECURITY: The key is a live credential. Do not paste it into chat/tickets/screenshots or
    commit it. There is ONE master key per deployment; losing it renders every stored tenant
    secret undecryptable, and rotating it requires re-encrypting all D1 ciphertext (re-enter
    tenant secrets in the UI). See docs/security.md.

    PROTOTYPE tooling pending the IT/security review gate (SoW §5). Key custody must be
    reviewed by a qualified engineer before any production tenant is connected.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$SetSecret,
    [string]$WorkerDir = (Join-Path $PSScriptRoot '..' '..' 'worker')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 32 bytes = 256 bits for AES-256.
$bytes = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
    $keyB64 = [Convert]::ToBase64String($bytes)
}
finally {
    $rng.Dispose()
    # Zero the buffer so the raw key does not linger in managed memory longer than needed.
    [Array]::Clear($bytes, 0, $bytes.Length)
}

if ($SetSecret) {
    if (-not (Get-Command wrangler -ErrorAction SilentlyContinue)) {
        throw "wrangler not found on PATH. Install it (npm i -g wrangler) or run without -SetSecret and set the secret manually."
    }
    if ($PSCmdlet.ShouldProcess('MASTER_ENCRYPTION_KEY', 'wrangler secret put')) {
        Push-Location $WorkerDir
        try {
            # Pipe the key to wrangler's STDIN so it is never rendered to the console.
            $keyB64 | wrangler secret put MASTER_ENCRYPTION_KEY
            Write-Host 'MASTER_ENCRYPTION_KEY set via wrangler (value not displayed).'
        }
        finally {
            Pop-Location
        }
    }
}
else {
    # Emit ONLY the key on STDOUT so it can be piped: ./New-MasterKey.ps1 | wrangler secret put ...
    Write-Output $keyB64
}
