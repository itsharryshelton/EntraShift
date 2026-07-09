# EntraShift — Microsoft Entra ID App Registrations

EntraShift uses **three** separate Entra ID app registrations. Keeping them separate is a
security requirement (SoW Phase 0/1): the UI sign-in app never touches migration data, and each
migration app lives in the tenant whose data it moves, with least-privilege application
permissions.

| #   | App registration                       | Tenant             | Auth model                                                | Purpose                              |
| :----| :---------------------------------------| :-------------------| :----------------------------------------------------------| :-------------------------------------|
| 1   | **EntraShift UI (SSO)**                | MSP tenant         | OIDC Auth-Code + PKCE, **delegated**                      | Gate the Web UI to MSP engineers     |
| 2   | **EntraShift Migration (source)**      | Source tenant      | Client credentials, **application** perms + admin consent | Export mail + files from source      |
| 3   | **EntraShift Migration (destination)** | Destination tenant | Client credentials, **application** perms + admin consent | Provision users, import mail + files |

All migration Graph permissions are **application permissions requiring admin consent** — never
delegated (SoW §1). **No global admin credentials are ever stored by EntraShift.**

---

## 1. MSP-tenant UI SSO app (OIDC, PKCE)

Created **once**, in the **MSP tenant** (the tenant hosting the engineers who operate EntraShift).
This is the app referenced by `OIDC_CLIENT_ID` / `ENTRA_TENANT_ID` / `ALLOWED_GROUP_ID` in
`worker/wrangler.jsonc`.

### 1.1 Create the registration

Microsoft Entra admin center → **Identity → Applications → App registrations → New registration**:

- **Name:** `EntraShift UI`
- **Supported account types:** *Accounts in this organizational directory only* (single tenant — MSP).
- **Redirect URI:** platform **Web**, value `https://entrashift.example.com/auth/callback`
  (must exactly match `OIDC_REDIRECT_URI` in `wrangler.jsonc`; use your real Worker hostname).

### 1.2 Authentication settings

- **Web** platform only. Add the callback URI above; add your local dev callback separately if used.
- **Front-channel logout URL:** optional (`https://entrashift.example.com/`).
- **Implicit/hybrid grants:** leave **all unchecked**. EntraShift uses **Authorization Code + PKCE**,
  handled server-side in the Worker — there is no token issued to the browser.
- **Allow public client flows:** **No**.

The Worker holds the app's client secret (`OIDC_CLIENT_SECRET`, a Worker Secret) and completes the
code exchange server-side. PKCE is still used (code_verifier/challenge) as defence-in-depth per SoW
Phase 0. The `code_verifier`, `state`, and `nonce` are stored server-side in D1 (`auth_flow`),
never in the browser.

### 1.3 API permissions (delegated only)

Microsoft Graph → **Delegated**:

| Permission | Type | Why |
| :--- | :--- | :--- |
| `openid` | Delegated | OIDC sign-in |
| `profile` | Delegated | Display name |
| `email` | Delegated | UPN/email for audit `actorUpn` |

Grant admin consent so engineers are not individually prompted. **No application permissions on
this app** — it must not be able to read directory or mailbox data.

### 1.4 Group claim + restrict to the MSP security group

Access is restricted to members of a designated MSP security group (SoW Phase 0). Two parts:

1. **Emit the group claim** — App registration → **Token configuration → Add groups claim** →
   *Security groups* → for the **ID token**, emit **Group ID**. The Worker validates the group id
   in the ID token against `ALLOWED_GROUP_ID` on every sign-in (`/auth/callback` rejects users
   outside the group).
2. **Enforce assignment (defence-in-depth)** — Enterprise applications → *EntraShift UI* →
   **Properties → Assignment required? = Yes**, then **Users and groups →** assign the MSP security
   group. Now Entra itself blocks non-members from completing sign-in, in addition to the Worker's
   group-claim check.

> If your MSP group is large enough that Entra emits an *overage* claim instead of the group list,
> switch to a **group-filtered** groups claim (assigned groups only) or have the Worker resolve
> membership via the group-membership endpoint. The default assumes the designated security group
> is emitted directly.

### 1.5 Client secret

Create a client secret (short lifetime, e.g. 6 months). Store it as the Worker Secret
`OIDC_CLIENT_SECRET` (`wrangler secret put OIDC_CLIENT_SECRET`) — **never** in `wrangler.jsonc`,
source, or the browser. See [deployment.md](./deployment.md).

---

## 2 & 3. Source and destination migration apps

These are created with the provided script,
[`scripts/New-EntraShiftAppRegistrations.ps1`](./scripts/New-EntraShiftAppRegistrations.ps1), which
resolves each permission name to its Microsoft Graph app-role GUID at runtime, creates the app
registration, mints a client secret, and (optionally) grants admin consent.

### 2.1 Permission sets (least privilege — SoW §1)

**Source tenant** (export):

| Permission | App-role GUID | Purpose |
| :--- | :--- | :--- |
| `User.Read.All` | `df021288-bdef-4463-88db-98f22de89214` | Directory discovery |
| `MailboxItem.Export.All` | `937550e9-33a3-494b-88ae-d9cd394b1fbb` | Full-fidelity mailbox export (mail, calendar, contacts) |
| `MailboxFolder.Read.All` | `99280d24-a782-4793-93cc-0888549957f6` | Folder enumeration + delta |
| `MailboxSettings.Read` | `40f97065-369a-49f4-947c-6a255697ae91` | Mailbox settings capture |
| `Files.Read.All` | `01d4889c-1287-42c6-ac1f-5d1e02578ef6` | OneDrive content read |

**Destination tenant** (provision + import):

| Permission | App-role GUID | Purpose |
| :--- | :--- | :--- |
| `User.ReadWrite.All` | `741f803b-c850-494e-b5df-cde7c675a1ca` | User provisioning (narrower than `Directory.ReadWrite.All`) |
| `MailboxItem.ImportExport.All` | `76577085-e73d-4f1d-b26a-85fb33892327` | Mailbox import |
| `MailboxFolder.ReadWrite.All` | `fef87b92-8391-4589-9da7-eb93dab7dc8a` | Folder creation |
| `Files.ReadWrite.All` | `75359482-378d-4052-8f01-80520e7db3cd` | OneDrive content write |
| `Sites.FullControl.All` | `a82116e5-55eb-4c41-a434-62fe8a61c773` | OneDrive pre-provisioning |

> **`Directory.ReadWrite.All` is deliberately excluded** as over-scoped (SoW §1). Destination user
> provisioning uses the narrower `User.ReadWrite.All`. If a future feature genuinely needs directory
> write beyond user objects, it must be justified in a security review — do not add it here as a
> convenience.
>
> The GUIDs are documented for reference; the script does **not** hardcode them — it looks each up
> from the tenant's Microsoft Graph service principal so a Microsoft-side change can't silently
> mis-assign a role.

### 2.2 Run the script

Prerequisites: `Install-Module Microsoft.Graph -Scope CurrentUser`.

```powershell
# --- SOURCE tenant ---
Connect-MgGraph -TenantId <SOURCE_TENANT_ID> `
  -Scopes "Application.ReadWrite.All","AppRoleAssignment.ReadWrite.All"
./scripts/New-EntraShiftAppRegistrations.ps1 -Role source -WhatIf   # dry run first
./scripts/New-EntraShiftAppRegistrations.ps1 -Role source -GrantAdminConsent

# --- DESTINATION tenant ---
Connect-MgGraph -TenantId <DEST_TENANT_ID> `
  -Scopes "Application.ReadWrite.All","AppRoleAssignment.ReadWrite.All"
./scripts/New-EntraShiftAppRegistrations.ps1 -Role destination -WhatIf
./scripts/New-EntraShiftAppRegistrations.ps1 -Role destination -GrantAdminConsent
```

The script prints **Tenant ID**, **Client ID**, and the **Client Secret (shown once)**. Paste them
straight into **EntraShift → Tenant Connections**. The secret is AES-256-GCM envelope-encrypted in
the Worker; only ciphertext + IV are written to D1 (SoW Phase 0). It is never returned to the
browser and never logged.

The script is **idempotent**: re-running finds the app by display name and reconciles its required
permissions. A new secret is minted only on first creation or with `-RotateSecret` (Microsoft does
not allow reading a secret back after creation).

### 2.3 Admin consent

`-GrantAdminConsent` creates the `appRoleAssignments` programmatically and requires the operator to
be **Global Administrator** or **Privileged Role Administrator** in that tenant. If you omit it, the
script prints the admin-consent URL:

```
https://login.microsoftonline.com/<TENANT_ID>/adminconsent?client_id=<CLIENT_ID>
```

Have an admin open it and consent. After consent, use the EntraShift **Tenant Connections → Test
connection** button — it acquires an app-only token and probes each required scope, reporting
per-scope pass/fail and any missing consent (api-spec `POST /api/tenants/:id/test`).

---

## 3. Scoping application permissions to migration targets (strongly recommended)

Application permissions like `MailboxItem.Export.All` and `Files.ReadWrite.All` are **tenant-wide**
by default — the app can touch *every* mailbox/drive. Where the customer requires it (and for pilots
this should be the default), scope each app to only the migration-target users. Do this **before**
granting the app to a production tenant.

### 3.1 Exchange mailboxes — ApplicationAccessPolicy

Scopes the Graph mailbox import/export APIs to a mail-enabled security group. Run in the tenant that
owns the mailboxes (source for export; destination for import), via Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline -Organization contoso.onmicrosoft.com

# 1. Group containing ONLY the in-scope mailboxes.
New-DistributionGroup -Name "EntraShift-Migration-Scope" -Type Security `
  -Members user1@contoso.com,user2@contoso.com

# 2. Restrict the migration app to that group.
New-ApplicationAccessPolicy -AppId <CLIENT_ID> `
  -PolicyScopeGroupId EntraShift-Migration-Scope@contoso.com `
  -AccessRight RestrictAccess `
  -Description "EntraShift migration app limited to in-scope mailboxes."

# 3. Verify — in-scope should be Granted, everyone else Denied.
Test-ApplicationAccessPolicy -AppId <CLIENT_ID> -Identity user1@contoso.com
Test-ApplicationAccessPolicy -AppId <CLIENT_ID> -Identity notinscope@contoso.com
```

Policy changes can take a few minutes to propagate. `ApplicationAccessPolicy` governs the Exchange
mailbox APIs only.

### 3.2 RBAC for Applications (newer, granular Exchange scoping)

Exchange Online's **RBAC for Applications** assigns a management role to the app's service principal
with a scope restricted to specific recipients — more granular and auditable than
`ApplicationAccessPolicy`:

```powershell
# Register the app as a service principal in Exchange RBAC, then scope a mail-read/write role
# to a management scope covering only the migration-target recipients.
New-ServicePrincipal -AppId <CLIENT_ID> -ObjectId <ENTERPRISE_APP_OBJECT_ID> `
  -DisplayName "EntraShift Migration (source)"

New-ManagementScope -Name "EntraShift-Scope" `
  -RecipientRestrictionFilter "CustomAttribute1 -eq 'EntraShiftMigrate'"

New-ManagementRoleAssignment -App <SERVICE_PRINCIPAL_ID> `
  -Role "Application Mail.Read" -CustomResourceScope "EntraShift-Scope"
```

Choose the Exchange application role matching the Graph permission you granted (e.g. the
`Application MailboxItem.Export` / `Application MailboxItem.ImportExport` roles). See
[RBAC for Applications in Exchange Online](https://learn.microsoft.com/exchange/permissions-exo/application-rbac).

### 3.3 OneDrive / SharePoint scoping

`ApplicationAccessPolicy` does **not** cover files. `Files.Read.All` / `Files.ReadWrite.All` /
`Sites.FullControl.All` are enforced at the SharePoint/OneDrive layer. Options:

- Prefer **`Sites.Selected`** with per-site grants where the workflow allows, instead of tenant-wide
  `Sites.FullControl.All`, and grant only the target users' OneDrive sites. (SoW lists
  `Sites.FullControl.All` for pre-provisioning; a security review may substitute `Sites.Selected`
  once the exact pre-provisioning calls are pinned down.)
- Otherwise, restrict operationally: the engine only ever touches the drives of users in the
  migration queue, and the audit log records every provisioning/job action.

---

## 4. Metering / billing warning (confirm before large migrations)

The **`MailboxItem.*`** mailbox import/export APIs may be **metered/billed by Microsoft**. Per SoW
§1.2, confirm the current metering and billing status for these APIs **before** running a large
migration, and surface the projected cost-per-GB to the engineer. The 20-item export batch cap and
Graph throttling — not bandwidth — dominate Exchange throughput, so a large mailbox estate can
generate a very large number of metered API calls. Validate cost against a pilot first (pilot gate,
SoW §5).

---

## 5. Post-setup checklist

- [ ] UI SSO app created in **MSP tenant**; redirect URI matches `OIDC_REDIRECT_URI`; groups claim
      emitted; assignment required + MSP security group assigned; `OIDC_CLIENT_SECRET` set as a
      Worker Secret.
- [ ] Source migration app created; exactly the 5 source permissions above; admin consent granted.
- [ ] Destination migration app created; exactly the 5 destination permissions above; admin consent
      granted.
- [ ] `Directory.ReadWrite.All` **not** present on any app.
- [ ] Mailbox scoping (ApplicationAccessPolicy or RBAC for Applications) applied for pilots /
      where the customer requires it.
- [ ] `MailboxItem.*` metering/billing confirmed for the planned migration volume.
- [ ] Tenant Connections **Test connection** shows all scopes green for both tenants.
