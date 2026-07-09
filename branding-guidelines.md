# EntraShift — Brand Identity & Design System Guidelines
**Product:** Custom Open Source M365 to M365 Tenant Migration Tool  
**Target Audience:** Enterprise IT Administrators, Managed Service Providers (MSPs), Cloud Architects  
**Similar Products:** Quest, BitTitan, ShareGate, AvePoint.

---

## 1. Brand Core & Positioning

### 1.1 Brand Essence
**EntraShift** is a secure, cloud-native utility built to streamline complex Microsoft 365 tenant-to-tenant migrations. The name bridges **"Entra"** (the anchor of modern Microsoft identity and directory security) with **"Shift"** (action, progression, and the seamless movement of workloads from source to destination).

### 1.2 Core Pillars
* **Security-First Architecture:** Eliminates global admin credential exposure by utilizing native Microsoft Entra ID App Registrations and scoped Graph API permissions.
* **Decoupled Efficiency:** Leverages high-performance edge computing (Cloudflare Workers) for management, backed by powerful, isolated compute (Azure/Hyper-V) for heavy data movement.
* **Zero-Friction UX:** Replaces bloated, legacy migration screens with an intuitive, minimalist UI that simplifies complex data mapping and bulk CSV discovery.

### 1.3 Voice & Tone
The EntraShift voice should be **Authoritative, Reassuring, and Highly Technical but Accessible**.
* **Do:** Use precise technical vocabulary (e.g., "delta sync," "pre-provisioning," "OAuth handshake"). Keep copy concise and utility-focused.
* **Don't:** Use over-the-top marketing hype, ambiguous buzzwords, or overly casual/playful language that might undermine the perceived security of data-handling enterprise software.

---

## 2. Visual Identity & Logo Design

### 2.1 The Concept
The logo should visually convey security, data transfer, and the Microsoft ecosystem without cloning native Microsoft iconography.

* **Primary Motif:** Two overlapping geometric nodes or brackets representing the Source and Destination tenants, connected by a dynamic, directional "shift" element (a sharp arrow or a bridge of light).
* **Abstract Alternative:** A stylized typography treatment of the letter **"E"** transitioning into an arrow or a fast-forward symbol pointing right, signifying data velocity and progress.

### 2.2 Logo Usage Guidelines
* **Clear Space:** The logo must always be surrounded by clear space equal to at least 50% of the logo's total width to maintain visual integrity in dense IT dashboards.
* **Minimum Size:** 24px height in digital UI layout to ensure the directional elements remain sharp and identifiable.

---

## 3. Color Palette

The EntraShift palette draws loose inspiration from the deep indigos/purples found in Microsoft Entra's branding, balanced with a hyper-modern edge computing aesthetic (slate and deep electric blues).

### 3.1 Primary Brand Colors
* **Entra Indigo (Core Brand Identity & Primary Buttons)**
    * Hex: `#5046E5`
    * RGB: `80, 70, 229`
    * Usage: Primary branding, headers, main call-to-action (CTA) buttons, and active application states.
* **Shift Cyan (Data Path & Accents)**
    * Hex: `#0EA5E9`
    * RGB: `14, 165, 233`
    * Usage: Highlighting data transfer arrows, success metrics, progress bars, and migration pipelines.

### 3.2 UI & Neutrals (Dark/Light Interface)
* **Console Slate (Deep Dark Backgrounds)**
    * Hex: `#0F172A`
    * RGB: `15, 23, 42`
    * Usage: Left-hand navigation sidebar, dark-mode terminal windows, and heavy data table headers.
* **Canvas Gray (Main Application Background)**
    * Hex: `#F8FAFC`
    * RGB: `248, 250, 252`
    * Usage: Main application workspace background, keeping the focus entirely on user tables and configuration settings.
* **Border Gray (Subtle UI Enclosures)**
    * Hex: `#E2E8F0`
    * RGB: `226, 232, 240`
    * Usage: Input box borders, card outlines, and dividers between table columns.

### 3.3 Functional States (Alerts & Indicators)
* **Success (Migration Completed):** Emerald Green (`#10B981`)
* **Warning (Delta Required / Sync Interrupted):** Amber (`#F59E0B`)
* **Error (Auth Expired / Provisioning Failed):** Crimson (`#EF4444`)

---

## 4. Typography

Typography must prioritize extreme legibility, crisp alignment for data grids, and a native SaaS feel.

### 4.1 UI & Display Sans-Serif
* **Primary Font:** `Inter` (or system fallback: `Segoe UI`, `-apple-system`)
* **Weights & Application:**
    * **Bold (700):** Page titles, primary numbers (e.g., "Active Migrations: 1,242").
    * **Medium (500):** Form labels, table headings, menu choices.
    * **Regular (400):** Description text, long-form help modals, tooltip text.

### 4.2 Data & Log Monospace
* **Code Font:** `JetBrains Mono` (fallback: `Fira Code`, `SFMono-Regular`)
* **Application:** CSV mapping text previews, tenant Client ID/Secret entry text boxes, live migration engine error output feeds, and system logs.

---

## 5. UI & Component Design Patterns

Since the frontend runs via Cloudflare Workers Web UI, design components must remain highly functional, lightweight, and structured for complex data tasks.

### 5.1 Connection Status Cards
When connecting to Source and Destination tenants, status elements should feature a dual-state container layout:
* **Disconnected:** Dotted Border Gray (`#E2E8F0`) with an empty state layout, urging the administrator to trigger an OAuth Enterprise Application handshake.
* **Connected:** A subtle, solid 1px border using Entra Indigo (`#5046E5`) with an inline green badge reading `Connected via App Reg`. Displays Tenant ID and a live expiry date of the client secret.

### 5.2 User Selection & Workload Grid
The data layout for choosing users should resemble a hybrid spreadsheet/dashboard layout:
* **Zebra Striping:** Alternating table rows (`#FFFFFF` and `#F8FAFC`) to help admins track long lines of user identities across wide screens.
* **Workload Selectors:** Clean, interactive pill-toggle boxes for `Exchange` and `OneDrive` workloads. 
    * *Active State:* Filled with Entra Indigo (`#5046E5`) with white text. **Do not place white text on Shift Cyan** — `#0EA5E9` fails WCAG AA contrast (~2.8:1) for text-bearing fills. Cyan is reserved for non-text accents (progress fills, arrows, glows); where a cyan-toned text chip is required, use Cyan 700 (`#0369A1`) fill with white text.
    * *Inactive State:* Light neutral gray fill with muted text.

### 5.3 Live Migration Progress Bars
* Instead of standard blocky native browser bars, progress bars must utilize a sleek, thin 6px track design (`#E2E8F0`) with a smooth gradient fill moving from `Entra Indigo` to `Shift Cyan` to simulate real-time cloud data flow.
* The progress bar must be paired with contextual text updating the user on the specific phase (e.g., `Provisioning OneDrive Site...`, `Migrating Inbox [1.2 GB / 4.5 GB]`).

---

## 6. Layout & Design Tokens

### 6.1 Spacing Scale
4px base unit. Permitted steps: `4, 8, 12, 16, 24, 32, 48, 64`. No arbitrary values — dense data grids use 8px cell padding vertical / 12px horizontal; page gutters 24px (desktop), 16px (narrow).

### 6.2 Grid & Breakpoints
* App shell: fixed 240px sidebar (Console Slate) + fluid content area, max content width 1440px.
* Breakpoints: `≥1280px` full layout; `1024–1279px` sidebar collapses to 64px icon rail; `<1024px` sidebar becomes overlay drawer. Data grids scroll horizontally below 1024px rather than reflowing — admins prefer intact columns.
* Minimum supported viewport: 1024×768. This is an admin console, not a consumer app; phone layouts are out of scope.

### 6.3 Radius & Elevation
* Border radius: `6px` inputs/buttons, `8px` cards, `12px` modals, `9999px` pills/badges.
* Elevation (light mode): Level 1 cards `0 1px 2px rgb(15 23 42 / 0.06)`; Level 2 dropdowns/popovers `0 4px 12px rgb(15 23 42 / 0.10)`; Level 3 modals `0 12px 32px rgb(15 23 42 / 0.18)`. Dark mode replaces shadows with 1px borders (`#334155`) plus subtle background lightening.

### 6.4 Dark Mode Palette
Dark mode is a first-class theme (admins run consoles at night), not just the sidebar.

| Token | Light | Dark |
| :--- | :--- | :--- |
| Background | `#F8FAFC` | `#0F172A` |
| Surface / card | `#FFFFFF` | `#1E293B` |
| Border | `#E2E8F0` | `#334155` |
| Text primary | `#0F172A` | `#F1F5F9` |
| Text secondary | `#475569` | `#94A3B8` |
| Primary action | `#5046E5` | `#6366F1` (lightened for contrast on dark surfaces) |
| Accent (non-text) | `#0EA5E9` | `#38BDF8` |
| Success / Warning / Error | `#10B981` / `#F59E0B` / `#EF4444` | `#34D399` / `#FBBF24` / `#F87171` |

### 6.5 Iconography
* **Icon set: Lucide** (open source, stroke-based, consistent with the palette's modern-slate aesthetic). Single set only — no mixing.
* Sizes: 16px inline/table, 20px buttons/nav, 24px page headers, 48px empty states. Stroke width 1.75.
* Workload glyphs: envelope = Exchange, cloud/folder = OneDrive — used consistently in grids, reports, and progress views.

---

## 7. Component States & Feedback Patterns

### 7.1 Interactive States (all controls)
* **Hover:** background shifts one step (e.g., Indigo darkens to `#4338CA`); never color-only on table rows — add background tint.
* **Focus-visible:** 2px outline `#5046E5` at 2px offset, on every focusable element. Keyboard operability is a hard requirement for an admin console.
* **Disabled:** 50% opacity + `not-allowed` cursor; disabled buttons keep their label (no spinner-only states).
* **Loading:** buttons show inline spinner + retain label (`Connecting…`); grids use skeleton rows (shimmer on `#E2E8F0`), never blank screens.

### 7.2 Empty States
Centered layout: 48px muted icon, one-line explanation, one primary action. E.g., no users discovered → "No users discovered yet. Connect a source tenant to begin." + `Connect Tenant` button.

### 7.3 Error & Alert Patterns
* **Inline field errors:** Crimson border + 12px helper text below field. Never rely on color alone — include icon + text.
* **Banner alerts:** full-width, functional-state colored left border (4px), icon, message, optional action. Auth-expiry and quota warnings persist until resolved (no auto-dismiss).
* **Toasts:** bottom-right, auto-dismiss 5s, success/info only. Errors never auto-dismiss.
* **Destructive confirmation:** cancelling a running migration or disconnecting a tenant requires a modal with explicit consequence text and a typed confirmation for tenant disconnect.

### 7.4 Data-Sensitive Display Rules
* Client secrets: masked (`••••`) in JetBrains Mono, never revealable after save; show expiry metadata only.
* Temporary password CSV download: modal must state that the file contains credentials and is a one-time download, with an acknowledge checkbox before the download button enables.

---

## 8. Screen Inventory (v1)

The complete set of screens the design system must cover:

1. **Sign-in** — Entra ID SSO redirect page: centered logo, single `Sign in with Microsoft` button, security posture one-liner. No local credential fields, ever.
2. **Dashboard** — connection status cards (§5.1), active migration count, throughput sparkline, recent errors summary, free-tier budget indicator (Workers/D1/Queues daily usage).
3. **Tenant Connections** — source/destination setup, permission-consent checklist with per-scope pass/fail, connection test results.
4. **User Discovery & Selection** — workload grid (§5.2), CSV import with line-level validation error table.
5. **Mapping & Provisioning** — source→target mapping table showing resolved target UPN (destination primary domain), auto-create toggles, temp-password CSV download modal (§7.4).
6. **Migration Monitor** — per-user job rows with phase text + progress bars (§5.3), delta-pass badges, throttle-state indicator (Amber when engine is backing off), cancel/retry actions.
7. **Migration Reports** — per-user drill-down: items succeeded/skipped/failed, error classes, data volume, duration; CSV export.
8. **Audit Log** — read-only, filterable (actor, action, date), monospace detail column, CSV export before retention pruning.
9. **Settings** — secret rotation, VM/service-token status, retention configuration.

---

## 9. Accessibility Baseline

* WCAG 2.2 AA minimum: text contrast ≥ 4.5:1, large text/UI components ≥ 3:1. Shift Cyan is decorative/accent only (§5.2 rule).
* All functional states (§3.3) pair color with icon + text label.
* Full keyboard navigation: logical tab order, focus-visible everywhere, `Esc` closes modals, grids navigable by arrow keys.
* Progress bars expose `role="progressbar"` with `aria-valuenow`; live phase text updates via `aria-live="polite"`.
* Respect `prefers-reduced-motion`: gradient/progress animations become static fills.