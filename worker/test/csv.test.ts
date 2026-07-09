import { describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv, validateImportCsv } from '../src/lib/csv';

const HEADER = 'SourceEmail,TargetEmail,MigrateExchange,MigrateOneDrive,AutoCreateTarget';

describe('validateImportCsv', () => {
  it('accepts well-formed rows (explicit target and auto-create)', () => {
    const csv = [HEADER, 'userA@source.com,userA@dest.com,true,true,false', 'userB@source.com,,true,false,true'].join('\n');
    const { accepted, rejected } = validateImportCsv(csv);
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(2);
    expect(accepted[0]).toMatchObject({ sourceEmail: 'userA@source.com', targetEmail: 'userA@dest.com', migrateExchange: true, migrateOneDrive: true, autoCreateTarget: false });
    expect(accepted[1]).toMatchObject({ sourceEmail: 'userB@source.com', targetEmail: null, autoCreateTarget: true });
  });

  it('rejects a malformed source email with a line-level error', () => {
    const csv = [HEADER, 'not-an-email,x@dest.com,true,false,false'].join('\n');
    const { accepted, rejected } = validateImportCsv(csv);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.line).toBe(2);
    expect(rejected[0]!.reason).toMatch(/Malformed SourceEmail/);
  });

  it('rejects rows with the wrong number of columns', () => {
    const csv = [HEADER, 'userA@source.com,userA@dest.com,true'].join('\n');
    const { rejected } = validateImportCsv(csv);
    expect(rejected[0]!.line).toBe(2);
    expect(rejected[0]!.reason).toMatch(/columns/);
  });

  it('rejects non-boolean workload flags', () => {
    const csv = [HEADER, 'userA@source.com,userA@dest.com,maybe,false,false'].join('\n');
    const { rejected } = validateImportCsv(csv);
    expect(rejected[0]!.reason).toMatch(/true or false/);
  });

  it('flags duplicate source addresses within the file (case-insensitive)', () => {
    const csv = [HEADER, 'dupe@source.com,a@dest.com,true,false,false', 'DUPE@source.com,b@dest.com,true,false,false'].join('\n');
    const { accepted, rejected } = validateImportCsv(csv);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.line).toBe(3);
    expect(rejected[0]!.reason).toMatch(/Duplicate SourceEmail/);
  });

  it('flags addresses that duplicate ones already in the queue', () => {
    const csv = [HEADER, 'existing@source.com,x@dest.com,true,false,false'].join('\n');
    const { accepted, rejected } = validateImportCsv(csv, { existingSourceEmails: ['existing@source.com'] });
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.reason).toMatch(/Duplicate SourceEmail/);
  });

  it('flags unresolvable targets (no target and not auto-create)', () => {
    const csv = [HEADER, 'userC@source.com,,true,false,false'].join('\n');
    const { accepted, rejected } = validateImportCsv(csv);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]!.reason).toMatch(/Unresolvable target/);
  });

  it('rejects rows with no workload selected', () => {
    const csv = [HEADER, 'userD@source.com,userD@dest.com,false,false,false'].join('\n');
    const { rejected } = validateImportCsv(csv);
    expect(rejected[0]!.reason).toMatch(/At least one workload/);
  });

  it('rejects a bad header', () => {
    const csv = ['Wrong,Header,Cols', 'a@b.com,c@d.com,true'].join('\n');
    const { rejected } = validateImportCsv(csv);
    expect(rejected[0]!.line).toBe(1);
    expect(rejected[0]!.reason).toMatch(/Header must be/);
  });

  it('collects a mix of accepted and rejected with correct line numbers', () => {
    const csv = [
      HEADER,
      'ok1@source.com,ok1@dest.com,true,true,false', // line 2 ok
      'bad-email,x@dest.com,true,false,false', // line 3 reject
      'ok2@source.com,,false,true,true', // line 4 ok (auto-create)
      'ok1@source.com,dupe@dest.com,true,false,false', // line 5 duplicate
    ].join('\n');
    const { accepted, rejected } = validateImportCsv(csv);
    expect(accepted.map((a) => a.sourceEmail)).toEqual(['ok1@source.com', 'ok2@source.com']);
    expect(rejected.map((r) => r.line)).toEqual([3, 5]);
  });
});

describe('parseCsv / serializeCsv', () => {
  it('handles quoted fields, embedded commas and escaped quotes', () => {
    const rows = parseCsv('a,"b,c","he said ""hi"""\r\n1,2,3');
    expect(rows[0]).toEqual(['a', 'b,c', 'he said "hi"']);
    expect(rows[1]).toEqual(['1', '2', '3']);
  });

  it('serialises with quoting and round-trips', () => {
    const csv = serializeCsv(['x', 'y'], [['plain', 'has,comma'], ['line\nbreak', 'quote"here']]);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(['x', 'y']);
    expect(rows[1]).toEqual(['plain', 'has,comma']);
    expect(rows[2]).toEqual(['line\nbreak', 'quote"here']);
  });
});
