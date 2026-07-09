/**
 * Theme management (branding §6.4, §9).
 *
 * - Persists the chosen theme in localStorage under `entrashift.theme`.
 * - Falls back to the OS `prefers-color-scheme` when nothing is stored.
 * - Exposes a React hook + a small pub/sub so any component can toggle.
 * - Also tracks `prefers-reduced-motion` and reflects it on <html> so CSS and
 *   the ProgressBar component can render static fills (§9).
 */

import { useSyncExternalStore, useCallback } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'entrashift.theme';

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  );
}

function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return readStored() ?? (systemPrefersDark() ? 'dark' : 'light');
}

/* ---- minimal store so useSyncExternalStore can subscribe ---- */
const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

function apply(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage may be blocked; theme still applies for the session */
  }
  emit();
}

export function setTheme(theme: Theme) {
  apply(theme);
}

export function toggleTheme() {
  apply(currentTheme() === 'dark' ? 'light' : 'dark');
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React hook: current theme + toggle. */
export function useTheme(): { theme: Theme; toggle: () => void; set: (t: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'light' as Theme);
  const toggle = useCallback(() => toggleTheme(), []);
  const set = useCallback((t: Theme) => setTheme(t), []);
  return { theme, toggle, set };
}

/**
 * Reflect prefers-reduced-motion onto <html data-reduced-motion> so CSS + JS
 * can honour it (§9). Call once at app boot.
 */
export function initReducedMotion(): void {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const set = () =>
    document.documentElement.setAttribute(
      'data-reduced-motion',
      String(mq.matches),
    );
  set();
  mq.addEventListener?.('change', set);
}

/** True when the user has requested reduced motion (used by ProgressBar). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}
