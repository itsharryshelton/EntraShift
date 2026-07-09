/** Time helpers — everything in the control plane is ISO-8601 UTC (per api-spec). */

/** Current instant as ISO-8601 UTC, e.g. 2026-07-09T12:34:56.789Z. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** ISO-8601 UTC `seconds` in the future from now. */
export function isoInSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** Current UTC calendar day as YYYY-MM-DD (budget-counter partition key). */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** True if the given ISO timestamp is in the past (expired). */
export function isPast(iso: string): boolean {
  return Date.parse(iso) <= Date.now();
}

/** Whole seconds elapsed between two ISO timestamps (b - a). */
export function secondsBetween(aIso: string, bIso: string): number {
  return Math.round((Date.parse(bIso) - Date.parse(aIso)) / 1000);
}
