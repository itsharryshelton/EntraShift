/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base path for API/auth calls; empty means same-origin (default). */
  readonly VITE_API_BASE?: string;
  /** Cosmetic build/env label shown in the UI. Never sensitive. */
  readonly VITE_APP_ENV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
