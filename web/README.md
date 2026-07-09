# EntraShift — Web UI

The React admin console for EntraShift (the control-plane front-end). It renders
the nine screens of the design system and talks to the Cloudflare Worker over the
API contract in [`../shared/api-spec.md`](../shared/api-spec.md), using the shared
types in [`../shared/contracts.ts`](../shared/contracts.ts).

## Stack

- **React 18 + TypeScript + Vite**
- **react-router-dom** for routing
- **lucide-react** for the (single) icon set
- **@fontsource** Inter + JetBrains Mono (self-hosted; no runtime CDN)

The build output (`web/dist`) is served as static assets by the Worker
(`worker/wrangler.jsonc` → `assets.directory: "../web/dist"`). Client-side routes
fall back to `index.html`; `/api/*` and `/auth/*` are handled by the Worker.

## Project layout

```
web/
├─ index.html                 # sets theme before paint (no FOUC)
├─ src/
│  ├─ main.tsx                 # entry: fonts, tokens, styles, mount
│  ├─ App.tsx                  # router + auth gate
│  ├─ AppShell.tsx             # sidebar + top bar layout
│  ├─ styles/
│  │  ├─ tokens.css            # ALL design tokens (light + dark, §3/§6)
│  │  ├─ global.css            # base reset, focus ring, reduced motion
│  │  └─ app.css               # shell + page primitives
│  ├─ lib/
│  │  ├─ api.ts                # typed fetch client (matches api-spec.md)
│  │  ├─ theme.ts              # theme toggle/persist + reduced-motion
│  │  ├─ format.ts             # bytes / UTC dates / durations
│  │  ├─ session.tsx           # session context (GET /api/me)
│  │  └─ useAsync.ts           # small data-loading hook
│  ├─ components/              # design-system components (accessible)
│  └─ screens/                 # the 9 screens (§8)
```

## Design system

Implemented strictly from [`../branding-guidelines.md`](../branding-guidelines.md):

- **Tokens** (`src/styles/tokens.css`): full color palette with the light/dark
  table (§6.4), 4px spacing scale, radii (6/8/12/9999), elevation levels 1–3,
  and typography weights. Dark mode is first-class.
- **Icons**: Lucide only, stroke width 1.75, standard sizes (§6.5).
- **Accessibility (§9)**: 2px indigo focus-visible ring at 2px offset on every
  focusable element, full keyboard nav, `Esc`-to-close modals with focus trap,
  `role="progressbar"` + `aria-valuenow`, `aria-live` phase text, and
  `prefers-reduced-motion` → static progress fills. Shift Cyan is a non-text
  accent only — never white text on cyan (§5.2).
- Minimum viewport **1024×768** — an admin console, no phone layout. Sidebar
  collapses to a 64px rail at 1024–1279px and to an overlay drawer below 1024px.

## Security notes (org policy)

- **No secrets in the front-end.** Nothing sensitive is stored in JS or
  `localStorage`. Tenant client secrets and the master encryption key live only
  in the Worker. Any `VITE_*` env var is inlined into the bundle and visible in
  the browser — see `.env.example`; keep it non-sensitive.
- **Auth**: browser calls use a server-side session cookie
  (`HttpOnly; Secure; SameSite=Strict`) with `credentials: 'include'`; a CSRF
  token from `GET /api/me` is sent on state-changing requests. The sign-in screen
  has **no local credential fields** — SSO redirect only.
- Client secrets are **write-only** in the UI: entered once, sent over TLS,
  encrypted server-side, and shown only as masked metadata + expiry afterwards
  (no reveal). Temp-password CSV download is a one-time, acknowledged action.

## Develop

```bash
npm install
npm run dev          # Vite dev server on :5173, proxies /api + /auth to :8787
```

Run the Worker locally (`cd ../worker && wrangler dev`) so the proxy targets a
real control plane. The UI degrades gracefully (skeletons / empty states) when
the API is unreachable.

## Build

```bash
npm run build        # tsc --noEmit -p tsconfig.json && vite build → web/dist
npm run typecheck    # type-only check
```

The Worker serves `web/dist`; deploy from `../worker` (see `worker/README.md`).
