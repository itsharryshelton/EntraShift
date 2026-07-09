/** D1 access for the `config` key/value table (engine + app settings). */

export type ConfigMap = Record<string, string>;

/** Load the whole config table into a plain map. */
export async function getAllConfig(db: D1Database): Promise<ConfigMap> {
  const { results } = await db.prepare('SELECT key, value FROM config').all<{ key: string; value: string }>();
  const map: ConfigMap = {};
  for (const row of results) map[row.key] = row.value;
  return map;
}

/** Read one config value, or a fallback if absent. */
export async function getConfigValue(db: D1Database, key: string, fallback: string): Promise<string> {
  const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

/** Numeric helper. */
export function num(map: ConfigMap, key: string, fallback: number): number {
  const v = Number(map[key]);
  return Number.isFinite(v) ? v : fallback;
}

/** Upsert a single config value. Counts as one D1 write. */
export async function setConfigValue(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}
