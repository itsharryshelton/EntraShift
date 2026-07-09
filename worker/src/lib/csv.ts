/**
 * CSV parse / serialise + the bulk-import validator (SoW Phase 2).
 *
 * Import format:
 *   SourceEmail,TargetEmail,MigrateExchange,MigrateOneDrive,AutoCreateTarget
 *   userA@source.com,userA@dest.com,true,true,false
 *   userB@source.com,,true,false,true
 *
 * Validation on upload (before any job is queued):
 *  - malformed rows rejected with line-level errors,
 *  - duplicate source addresses flagged,
 *  - unresolvable target addresses flagged (no TargetEmail AND AutoCreateTarget=false).
 */

/* ------------------------------------------------------------------ *
 * Generic RFC-4180-ish parser / serialiser (used by exports too).
 * ------------------------------------------------------------------ */

/** Parse CSV text into rows of string cells. Handles quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  // Final field/row if the file doesn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Serialise a header + rows into CSV text (quotes cells that need it). CRLF line endings. */
export function serializeCsv(headers: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  const esc = (v: string | number | boolean | null | undefined): string => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))];
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * Import validator.
 * ------------------------------------------------------------------ */

export interface CsvImportRow {
  sourceEmail: string;
  targetEmail: string | null;
  migrateExchange: boolean;
  migrateOneDrive: boolean;
  autoCreateTarget: boolean;
}

export interface CsvImportResult {
  accepted: CsvImportRow[];
  rejected: Array<{ line: number; reason: string }>;
}

const EXPECTED_HEADERS = ['SourceEmail', 'TargetEmail', 'MigrateExchange', 'MigrateOneDrive', 'AutoCreateTarget'];
// Pragmatic email shape check — full RFC 5322 is not the goal; catching obvious typos is.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(v)) return true;
  if (['false', '0', 'no', 'n', ''].includes(v)) return false;
  return null;
}

/**
 * Validate a bulk-import CSV. `existingSourceEmails` lets the caller flag rows that duplicate
 * addresses already in the migration queue (case-insensitive).
 */
export function validateImportCsv(text: string, opts: { existingSourceEmails?: string[] } = {}): CsvImportResult {
  const accepted: CsvImportRow[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];
  const seen = new Set<string>((opts.existingSourceEmails ?? []).map((e) => e.toLowerCase()));

  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== '')); // drop blank lines
  if (rows.length === 0) return { accepted, rejected: [{ line: 1, reason: 'File is empty' }] };

  // Header check (case-insensitive, order-sensitive to keep the mapping unambiguous).
  const header = rows[0]!.map((h) => h.trim());
  const headerOk =
    header.length >= EXPECTED_HEADERS.length &&
    EXPECTED_HEADERS.every((h, i) => header[i]?.toLowerCase() === h.toLowerCase());
  if (!headerOk) {
    return { accepted, rejected: [{ line: 1, reason: `Header must be: ${EXPECTED_HEADERS.join(',')}` }] };
  }

  for (let i = 1; i < rows.length; i++) {
    const line = i + 1; // 1-based file line (row 0 = header on line 1)
    const cols = rows[i]!;
    if (cols.length < EXPECTED_HEADERS.length) {
      rejected.push({ line, reason: `Expected ${EXPECTED_HEADERS.length} columns, got ${cols.length}` });
      continue;
    }

    const sourceEmail = (cols[0] ?? '').trim();
    const targetEmailRaw = (cols[1] ?? '').trim();
    const migrateExchange = parseBool(cols[2] ?? '');
    const migrateOneDrive = parseBool(cols[3] ?? '');
    const autoCreateTarget = parseBool(cols[4] ?? '');

    if (!sourceEmail) {
      rejected.push({ line, reason: 'SourceEmail is required' });
      continue;
    }
    if (!EMAIL_RE.test(sourceEmail)) {
      rejected.push({ line, reason: `Malformed SourceEmail: ${sourceEmail}` });
      continue;
    }
    if (migrateExchange === null || migrateOneDrive === null || autoCreateTarget === null) {
      rejected.push({ line, reason: 'MigrateExchange/MigrateOneDrive/AutoCreateTarget must be true or false' });
      continue;
    }
    if (targetEmailRaw && !EMAIL_RE.test(targetEmailRaw)) {
      rejected.push({ line, reason: `Malformed TargetEmail: ${targetEmailRaw}` });
      continue;
    }
    if (!migrateExchange && !migrateOneDrive) {
      rejected.push({ line, reason: 'At least one workload (Exchange or OneDrive) must be selected' });
      continue;
    }
    // Unresolvable target: no explicit target AND not auto-creating one.
    if (!targetEmailRaw && !autoCreateTarget) {
      rejected.push({ line, reason: 'Unresolvable target: provide TargetEmail or set AutoCreateTarget=true' });
      continue;
    }
    const key = sourceEmail.toLowerCase();
    if (seen.has(key)) {
      rejected.push({ line, reason: `Duplicate SourceEmail: ${sourceEmail}` });
      continue;
    }
    seen.add(key);

    accepted.push({
      sourceEmail,
      targetEmail: targetEmailRaw || null,
      migrateExchange,
      migrateOneDrive,
      autoCreateTarget,
    });
  }

  return { accepted, rejected };
}
