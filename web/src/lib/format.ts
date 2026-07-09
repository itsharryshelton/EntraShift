/**
 * Formatting helpers. All dates render in UTC (the whole system is UTC per
 * api-spec.md), so an engineer in any timezone reads the same timestamps the
 * audit log and D1 recorded.
 */

/** Human-readable bytes (base-1024, IEC-ish but with familiar KB/MB/GB labels). */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, i);
  // Whole bytes never need a decimal.
  const d = i === 0 ? 0 : digits;
  return `${value.toFixed(d)} ${units[i]}`;
}

/** Full UTC timestamp, e.g. "2026-07-09 14:32:05 UTC". */
export function formatDateTimeUtc(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

/** Date only, UTC, e.g. "2026-07-09". */
export function formatDateUtc(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

/** Relative "time ago" for recent events (falls back to absolute > 30d). */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day <= 30) return `${day}d ago`;
  return formatDateUtc(iso);
}

/** Duration in seconds → "1h 12m 05s" / "12m 05s" / "45s". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** Integer with thousands separators, e.g. 1242 → "1,242". */
export function formatCount(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

/** Percentage 0–100 given current/total; returns null when total is unknown. */
export function toPercent(
  current: number,
  total: number | null | undefined,
): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((current / total) * 100)));
}

/** Mask a secret-ish identifier, keeping the last 4 chars (§7.4). */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return '••••';
  const tail = value.slice(-4);
  return `••••••••${tail}`;
}
