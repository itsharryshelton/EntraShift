<#
.SYNOPSIS
    EntraShift — create the SOURCE and DESTINATION migration App Registrations with the exact
    least-privilege application permission sets from SoW §1, mint client secrets, and print the
    tenant/client IDs to paste into the EntraShift Tenant Connections screen.

.DESCRIPTION
    This script uses the Microsoft.Graph PowerShell SDK to provision the two *migration* app
    registrations (NOT the MSP-tenant UI SSO app — that one is documented in
    docs/app-registrations.md and created separately, in the MSP tenant).

    Run it TWICE — once connected to the source tenant, once connected to the destination
    tenant — selecting the matching -Role each time:

        # Source tenant
        Connect-MgGraph -TenantId <SOURCE_TENANT_ID> -Scopes "Application.ReadWrite.All","AppRoleAssignment.ReadWrite.All"
        ./New-EntraShiftAppRegistrations.ps1 -Role source

        # Destination tenant
        Connect-MgGraph -TenantId <DEST_TENANT_ID> -Scopes "Application.ReadWrite.All","AppRoleAssignment.ReadWrite.All"
        ./New-EntraShiftAppRegistrations.ps1 -Role destination

    Application permissions granted (least privilege — SoW §1 table):

      SOURCE
        User.Read.All              Directory discovery
        MailboxItem.Export.All     Full-fidelity mailbox export (mail/calendar/contacts)
        MailboxFolder.Read.All     Folder enumeration + delta
        MailboxSettings.Read       Mailbox settings capture
        Files.Read.All             OneDrive content read

      DESTINATION
        User.ReadWrite.All         User provisioning (narrower than Directory.ReadWrite.All)
        MailboxItem.ImportExport.All   Mailbox import
        MailboxFolder.ReadWrite.All    Folder creation
        Files.ReadWrite.All            OneDrive content write
        Sites.FullControl.All          OneDrive pre-provisioning

    Directory.ReadWrite.All is DELIBERATELY EXCLUDED as over-scoped (SoW §1).

    Idempotency: re-running finds the existing app by displayName and reconciles its required
    permissions instead of creating a duplicate. A new client secret is only created when
    -RotateSecret is passed (or when the app is created for the first time), because secrets
    cannot be read back after creation.

.PARAMETER Role
    'source' or 'destination'. Selects the permission set and the app display name.

.PARAMETER AppNamePrefix
    Display-name prefix. Defaults to 'EntraShift Migration'. Final name is
    "<prefix> (source)" / "<prefix> (destination)".

.PARAMETER SecretMonths
    Client-secret lifetime in months (default 6). Keep short; rotate via the EntraShift UI.

.PARAMETER RotateSecret
    Force a new client secret even if the app already exists.

.PARAMETER GrantAdminConsent
    Attempt to grant tenant-wide admin consent programmatically (creates appRoleAssignments on
    the app's service principal). Requires the caller to be Privileged Role Administrator or
    Global Administrator. If omitted, the script prints the admin-consent URL instead.

.EXAMPLE
    ./New-EntraShiftAppRegistrations.ps1 -Role source -WhatIf
    # Dry run: shows every create/grant that WOULD happen, changes nothing.

.EXAMPLE
    ./New-EntraShiftAppRegistrations.ps1 -Role destination -GrantAdminConsent -SecretMonths 3

.NOTES
    Requires: Microsoft.Graph module (Install-Module Microsoft.Graph -Scope CurrentUser).
    Connect first with Connect-MgGraph using at minimum:
        Application.ReadWrite.All  (create app + secret)
        AppRoleAssignment.ReadWrite.All  (grant admin consent, only with -GrantAdminConsent)

    SECURITY: The generated client secret is printed ONCE. Paste it straight into the EntraShift
    Tenant Connections screen (it is AES-256-GCM envelope-encrypted in the Worker; only ciphertext
    is stored in D1 — SoW Phase 0). Do NOT store it in a file, ticket, or chat. Microsoft does not
    let you read it again after creation.

    PROTOTYPE tooling pending the IT/security review gate (SoW §5). Have a qualified engineer
    review scoping (see the ApplicationAccessPolicy section printed at the end) before connecting
    a production tenant.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('source', 'destination')]
    [string]$Role,

    [string]$AppNamePrefix = 'EntraShift Migration',

    [ValidateRange(1, 24)]
    [int]$SecretMonths = 6,

    [switch]$RotateSecret,

    [switch]$GrantAdminConsent
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Microsoft Graph resource (service principal) appId — constant across every tenant.
$GraphAppId = '00000003-0000-0000-c000-000000000000'

# Least-privilege APPLICATION permission (app role) sets, keyed by role.
# We resolve each name -> app-role GUID at runtime from the Graph service principal so the
# script never depends on hardcoded IDs drifting. The GUIDs below are documented for reference
# only (verified against the Microsoft Graph permissions reference):
#
#   User.Read.All                 df021288-bdef-4463-88db-98f22de89214
#   User.ReadWrite.All            741f803b-c850-494e-b5df-cde7c675a1ca
#   MailboxItem.Export.All        937550e9-33a3-494b-88ae-d9cd394b1fbb
#   MailboxItem.ImportExport.All  76577085-e73d-4f1d-b26a-85fb33892327
#   MailboxFolder.Read.All        99280d24-a782-4793-93cc-0888549957f6
#   MailboxFolder.ReadWrite.All   fef87b92-8391-4589-9da7-eb93dab7dc8a
#   MailboxSettings.Read          40f97065-369a-49f4-947c-6a255697ae91
#   Files.Read.All                01d4889c-1287-42c6-ac1f-5d1e02578ef6
#   Files.ReadWrite.All           75359482-378d-4052-8f01-80520e7db3cd
#   Sites.FullControl.All         a82116e5-55eb-4c41-a434-62fe8a61c773
$PermissionSets = @{
    source      = @(
        'User.Read.All',
        'MailboxItem.Export.All',
        'MailboxFolder.Read.All',
        'MailboxSettings.Read',
        'Files.Read.All'
    )
    destination = @(
        'User.ReadWrite.All',
        'MailboxItem.ImportExport.All',
        'MailboxFolder.ReadWrite.All',
        'Files.ReadWrite.All',
        'Sites.FullControl.All'
    )
}

# --- Preconditions -----------------------------------------------------------------------
foreach ($mod in @('Microsoft.Graph.Authentication', 'Microsoft.Graph.Applications')) {
    if (-not (Get-Module -ListAvailable -Name $mod)) {
        throw "Required module '$mod' is not installed. Run: Install-Module Microsoft.Graph -Scope CurrentUser"
    }
}

$ctx = Get-MgContext
if (-not $ctx) {
    throw "Not connected. Run Connect-MgGraph -TenantId <TENANT_ID> -Scopes 'Application.ReadWrite.All','AppRoleAssignment.ReadWrite.All' first, then re-run for -Role $Role."
}

$tenantId = $ctx.TenantId
$displayName = "$AppNamePrefix ($Role)"
$wantedPermissions = $PermissionSets[$Role]

Write-Host ""
Write-Host "EntraShift App Registration — role '$Role'" -ForegroundColor Cyan
Write-Host "  Tenant:      $tenantId"
Write-Host "  App name:    $displayName"
Write-Host "  Permissions: $($wantedPermissions -join ', ')"
Write-Host ""

# --- Resolve the Graph service principal + map permission names -> app-role GUIDs ---------
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$GraphAppId'"
if (-not $graphSp) { throw "Microsoft Graph service principal not found in tenant $tenantId." }

# NB: use a distinct variable name ($appRole) here. `$role` would collide with the
# [ValidateSet]-constrained $Role parameter (PowerShell variable names are case-insensitive),
# and assigning an app-role object to it throws a validation MetadataError under
# $ErrorActionPreference='Stop', aborting the script before anything is created.
$resourceAccess = foreach ($permName in $wantedPermissions) {
    $appRole = $graphSp.AppRoles | Where-Object { $_.Value -eq $permName -and $_.AllowedMemberTypes -contains 'Application' }
    if (-not $appRole) {
        throw "App role '$permName' (Application) not found on Microsoft Graph in this tenant. Verify the permission name."
    }
    [PSCustomObject]@{ Id = $appRole.Id; Type = 'Role' }  # 'Role' = application permission
}

$requiredResourceAccess = @(
    @{
        ResourceAppId  = $GraphAppId
        ResourceAccess = @($resourceAccess | ForEach-Object { @{ Id = $_.Id; Type = $_.Type } })
    }
)

# --- Create or update the application (idempotent by displayName) -------------------------
$existing = Get-MgApplication -Filter "displayName eq '$displayName'" -ErrorAction SilentlyContinue | Select-Object -First 1

if ($existing) {
    Write-Host "Found existing app (appId $($existing.AppId)); reconciling required permissions." -ForegroundColor Yellow
    if ($PSCmdlet.ShouldProcess($displayName, 'Update requiredResourceAccess (least-privilege set)')) {
        Update-MgApplication -ApplicationId $existing.Id -RequiredResourceAccess $requiredResourceAccess
    }
    $app = $existing
}
else {
    if ($PSCmdlet.ShouldProcess($displayName, 'Create application registration')) {
        $app = New-MgApplication -DisplayName $displayName `
            -SignInAudience 'AzureADMyOrg' `
            -RequiredResourceAccess $requiredResourceAccess `
            -Notes 'EntraShift M365 tenant-to-tenant migration app (application permissions, admin consent). Prototype pending security review.'
        Write-Host "Created app (appId $($app.AppId))." -ForegroundColor Green
    }
    else {
        # -WhatIf: no object exists; synthesize a placeholder so the rest of the dry run prints.
        $app = [PSCustomObject]@{ Id = '<new>'; AppId = '<new-appId>' }
    }
}

# --- Ensure a service principal exists (needed for admin consent / assignments) -----------
$sp = $null
if ($app.AppId -ne '<new-appId>') {
    $sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $sp) {
        if ($PSCmdlet.ShouldProcess($displayName, 'Create service principal (enterprise app)')) {
            $sp = New-MgServicePrincipal -AppId $app.AppId
            Write-Host "Created service principal (objectId $($sp.Id))." -ForegroundColor Green
        }
    }
}

# --- Client secret ------------------------------------------------------------------------
# Secrets cannot be read after creation, so only create one on first-create or -RotateSecret.
$secretText = $null
$secretExpiry = $null
$needSecret = $RotateSecret -or (-not $existing)
if ($needSecret) {
    if ($PSCmdlet.ShouldProcess($displayName, "Create client secret (valid $SecretMonths months)")) {
        $pwCred = @{
            displayName   = "EntraShift $Role secret (created $(Get-Date -Format yyyy-MM-dd))"
            endDateTime   = (Get-Date).AddMonths($SecretMonths).ToUniversalTime().ToString('o')
        }
        $added = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential $pwCred
        $secretText = $added.SecretText
        $secretExpiry = $added.EndDateTime
    }
}
else {
    Write-Host "App already exists and -RotateSecret not set — leaving existing secret(s) untouched." -ForegroundColor Yellow
}

# --- Admin consent ------------------------------------------------------------------------
if ($GrantAdminConsent -and $sp) {
    Write-Host "Granting tenant-wide admin consent (appRoleAssignments)..." -ForegroundColor Cyan
    foreach ($permName in $wantedPermissions) {
        $appRole = $graphSp.AppRoles | Where-Object { $_.Value -eq $permName -and $_.AllowedMemberTypes -contains 'Application' }
        $already = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -All |
            Where-Object { $_.AppRoleId -eq $appRole.Id -and $_.ResourceId -eq $graphSp.Id }
        if ($already) {
            Write-Host "  = $permName already consented."
            continue
        }
        if ($PSCmdlet.ShouldProcess($permName, 'Grant admin consent (appRoleAssignment)')) {
            New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id `
                -PrincipalId $sp.Id -ResourceId $graphSp.Id -AppRoleId $appRole.Id | Out-Null
            Write-Host "  + $permName consented." -ForegroundColor Green
        }
    }
}

# --- Output the values the engineer pastes into EntraShift --------------------------------
$consentUrl = "https://login.microsoftonline.com/$tenantId/adminconsent?client_id=$($app.AppId)"

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " EntraShift $($Role.ToUpper()) app registration — copy into the UI" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  Tenant ID : $tenantId"
Write-Host "  Client ID : $($app.AppId)"
if ($secretText) {
    Write-Host "  Client Secret (SHOWN ONCE — paste now, never stored in plaintext):" -ForegroundColor Yellow
    Write-Host "    $secretText" -ForegroundColor Yellow
    Write-Host "  Secret expiry : $secretExpiry"
}
else {
    Write-Host "  Client Secret : (unchanged — re-run with -RotateSecret to mint a new one)"
}
if (-not $GrantAdminConsent) {
    Write-Host ""
    Write-Host "  Admin consent NOT granted by this run. Have a Global/Privileged Role Admin open:"
    Write-Host "    $consentUrl"
}
Write-Host ""
Write-Host "  Next: EntraShift → Tenant Connections → add the $Role tenant with the values above," -ForegroundColor Gray
Write-Host "        then use the per-scope 'Test connection' button to verify every consent." -ForegroundColor Gray
Write-Host ""

# --- Optional mailbox scoping (RBAC for Applications / ApplicationAccessPolicy) -----------
# Application permissions grant TENANT-WIDE mailbox access. Where the customer requires it,
# scope each migration app to only the migration-target mailboxes. Two mechanisms exist:
#
#  (A) ApplicationAccessPolicy (Exchange Online PowerShell) — scope Graph mailbox APIs to a
#      mail-enabled security group. Run in the tenant that owns the mailboxes (source for
#      export perms; destination for import perms):
#
#      Connect-ExchangeOnline -Organization <tenant.onmicrosoft.com>
#      # 1. Create a mail-enabled security group holding ONLY the migration-target mailboxes:
#      New-DistributionGroup -Name "EntraShift-Migration-Scope" -Type Security `
#          -Members user1@contoso.com,user2@contoso.com
#      # 2. Restrict this app registration to that group:
#      New-ApplicationAccessPolicy -AppId <CLIENT_ID_FROM_ABOVE> `
#          -PolicyScopeGroupId EntraShift-Migration-Scope@contoso.com `
#          -AccessRight RestrictAccess `
#          -Description "EntraShift migration app limited to in-scope mailboxes."
#      # 3. Verify:
#      Test-ApplicationAccessPolicy -AppId <CLIENT_ID> -Identity user1@contoso.com
#      Test-ApplicationAccessPolicy -AppId <CLIENT_ID> -Identity outofscope@contoso.com  # should Denied
#
#  (B) RBAC for Applications (newer, granular Exchange management-role scoping) — assign the
#      app a management-role scope restricted to the migration-target recipients. See
#      docs/app-registrations.md for the New-ManagementRoleAssignment recipe.
#
# NOTE: ApplicationAccessPolicy governs Exchange mailbox APIs only. Files.* (OneDrive) scoping
# is enforced separately at the Sites/OneDrive layer — documented in docs/app-registrations.md.
Write-Host "Mailbox scoping (ApplicationAccessPolicy / RBAC for Applications): see the commented" -ForegroundColor Gray
Write-Host "recipe at the end of this script and docs/app-registrations.md." -ForegroundColor Gray
