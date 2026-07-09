/**
 * Screen 4 — User Discovery & Selection (branding §8.4, SoW Phase 2).
 *
 * Live source-tenant directory discovery (Graph User.Read.All, Worker-side and
 * paginated), a hybrid spreadsheet/dashboard grid (§5.2) with per-user workload
 * pill toggles, and CSV bulk import with a line-level validation error table.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users,
  Search,
  Upload,
  UserPlus,
  FileWarning,
  ArrowRight,
} from 'lucide-react';
import {
  Card,
  PageHeader,
  DataGrid,
  Button,
  Input,
  WorkloadPill,
  Badge,
  Banner,
  Modal,
  EmptyState,
  useToast,
  type Column,
} from '../components';
import {
  discovery,
  migrationUsers as usersApi,
  ApiError,
  type DiscoveredUser,
  type ImportResult,
} from '../lib/api';
import type { MigrationUser } from '@shared/contracts';

interface Selection {
  exchange: boolean;
  onedrive: boolean;
  archive: boolean;
}

const CSV_TEMPLATE =
  'SourceEmail,TargetEmail,MigrateExchange,MigrateOneDrive,AutoCreateTarget\n' +
  'userA@source.com,userA@dest.com,true,true,false\n' +
  'userB@source.com,,true,false,true';

export function UserDiscovery() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [users, setUsers] = useState<DiscoveredUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  const [selection, setSelection] = useState<Record<string, Selection>>({});
  const [adding, setAdding] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [queueCount, setQueueCount] = useState<number | null>(null);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Load discovered users on search change.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    discovery
      .users({ search: debounced || undefined }, controller.signal)
      .then((page) => {
        setUsers(page.items);
        setCursor(page.cursor);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return;
        setLoadError(
          e instanceof ApiError && e.code === 'not_found'
            ? 'Connect and verify a source tenant before discovering users.'
            : 'Could not reach the directory. Verify the source tenant connection.',
        );
        setUsers([]);
        setLoading(false);
      });
    return () => controller.abort();
  }, [debounced]);

  // Current queue size (for the "N in queue" chip).
  useEffect(() => {
    usersApi
      .list()
      .then((q) => setQueueCount(q.length))
      .catch(() => setQueueCount(null));
  }, [adding]);

  const loadMore = async () => {
    if (!cursor) return;
    try {
      const page = await discovery.users({ search: debounced || undefined, cursor });
      setUsers((prev) => [...prev, ...page.items]);
      setCursor(page.cursor);
    } catch {
      toast.error('Could not load more users.');
    }
  };

  const toggle = (id: string, key: keyof Selection) =>
    setSelection((prev) => {
      const cur = prev[id] ?? { exchange: false, onedrive: false, archive: false };
      const next = { ...cur, [key]: !cur[key] };
      // Selecting a workload implies the row is selected; deselect archive if no exchange.
      if (key === 'exchange' && !next.exchange) next.archive = false;
      return { ...prev, [id]: next };
    });

  const selectedRows = useMemo(
    () =>
      Object.entries(selection).filter(
        ([, s]) => s.exchange || s.onedrive,
      ),
    [selection],
  );

  const addSelected = async () => {
    if (selectedRows.length === 0) return;
    setAdding(true);
    const payload: Array<Partial<MigrationUser>> = selectedRows.map(([id, s]) => {
      const u = users.find((x) => x.id === id)!;
      return {
        sourceEmail: u.userPrincipalName,
        migrateExchange: s.exchange,
        migrateOneDrive: s.onedrive,
        includeArchive: s.archive,
        autoCreateTarget: false,
        mappingStatus: 'unmapped',
      };
    });
    try {
      await usersApi.add(payload);
      toast.success(
        `${payload.length} user${payload.length === 1 ? '' : 's'} added to the migration queue.`,
      );
      setSelection({});
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not add users.');
    } finally {
      setAdding(false);
    }
  };

  const columns: Column<DiscoveredUser>[] = [
    {
      key: 'select',
      header: '',
      width: '36px',
      cell: (u) => {
        const s = selection[u.id];
        const checked = Boolean(s && (s.exchange || s.onedrive));
        return (
          <input
            type="checkbox"
            aria-label={`Select ${u.userPrincipalName}`}
            checked={checked}
            onChange={() => {
              // Toggling the row checkbox turns both workloads on/off.
              setSelection((prev) => {
                const cur = prev[u.id];
                const on = !(cur && (cur.exchange || cur.onedrive));
                return {
                  ...prev,
                  [u.id]: { exchange: on, onedrive: on, archive: false },
                };
              });
            }}
            style={{ accentColor: 'var(--color-primary)' }}
          />
        );
      },
    },
    {
      key: 'user',
      header: 'User',
      cell: (u) => (
        <div className="stack">
          <span style={{ fontWeight: 500 }}>{u.displayName}</span>
          <span className="text-xs muted mono">{u.userPrincipalName}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Account',
      cell: (u) =>
        u.accountEnabled ? (
          <Badge variant="success">Enabled</Badge>
        ) : (
          <Badge variant="neutral">Disabled</Badge>
        ),
    },
    {
      key: 'workloads',
      header: 'Workloads',
      cell: (u) => {
        const s = selection[u.id];
        return (
          <div className="row gap-2 wrap">
            <WorkloadPill
              workload="exchange"
              active={Boolean(s?.exchange)}
              onToggle={() => toggle(u.id, 'exchange')}
            />
            <WorkloadPill
              workload="onedrive"
              active={Boolean(s?.onedrive)}
              onToggle={() => toggle(u.id, 'onedrive')}
            />
            <label
              className="checkbox-row text-xs"
              style={{ opacity: s?.exchange ? 1 : 0.5 }}
            >
              <input
                type="checkbox"
                checked={Boolean(s?.archive)}
                disabled={!s?.exchange}
                onChange={() => toggle(u.id, 'archive')}
              />
              Archive
            </label>
          </div>
        );
      },
    },
  ];

  return (
    <div className="section-gap">
      <PageHeader
        title="User Discovery & Selection"
        description="Discover live source-tenant users and choose workloads, or bulk-import a mapping CSV. Selected users move to the migration queue for mapping."
        actions={
          <>
            <Button variant="secondary" leftIcon={Upload} onClick={() => setImportOpen(true)}>
              Import CSV
            </Button>
            <Link to="/mapping">
              <Button variant="ghost" rightIcon={ArrowRight}>
                Go to Mapping
              </Button>
            </Link>
          </>
        }
      />

      {loadError && (
        <Banner tone="warning" title="Directory unavailable" action={
          <Link to="/tenants">
            <Button variant="secondary" size="sm">Tenant Connections</Button>
          </Link>
        }>
          {loadError}
        </Banner>
      )}

      <Card flush>
        <div className="toolbar" style={{ padding: 'var(--space-4) var(--space-6) 0' }}>
          <div style={{ width: 320, maxWidth: '100%' }}>
            <Input
              aria-label="Search users"
              placeholder="Search by name or UPN…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="row gap-2 grow" style={{ justifyContent: 'flex-end' }}>
            {queueCount != null && (
              <Badge variant="info" icon={Users}>
                {queueCount} in queue
              </Badge>
            )}
            <Button
              variant="primary"
              leftIcon={UserPlus}
              disabled={selectedRows.length === 0}
              loading={adding}
              loadingLabel="Adding…"
              onClick={() => void addSelected()}
            >
              Add {selectedRows.length || ''} to queue
            </Button>
          </div>
        </div>
        <div style={{ padding: 'var(--space-4) 0 0' }}>
          <DataGrid
            columns={columns}
            rows={users}
            rowKey={(u) => u.id}
            loading={loading}
            caption="Discovered source-tenant users"
            emptyState={
              <EmptyState
                icon={Search}
                message={
                  debounced
                    ? `No users match “${debounced}”.`
                    : 'No users discovered yet. Connect a source tenant to begin.'
                }
                action={
                  !debounced ? (
                    <Link to="/tenants">
                      <Button variant="primary" leftIcon={Users}>
                        Connect Tenant
                      </Button>
                    </Link>
                  ) : undefined
                }
              />
            }
          />
        </div>
        {cursor && !loading && (
          <div className="row" style={{ justifyContent: 'center', padding: 'var(--space-4)' }}>
            <Button variant="secondary" onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        )}
      </Card>

      {importOpen && (
        <CsvImportModal
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false);
            setAdding((a) => !a); // nudge queue count refresh
          }}
        />
      )}
    </div>
  );
}

/* ---- CSV import modal with line-level validation error table ---- */
function CsvImportModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const submit = async () => {
    if (!csv.trim()) {
      toast.error('Paste or choose a CSV first.');
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const res = await usersApi.importCsv(csv);
      setResult(res);
      if (res.rejected.length === 0) {
        toast.success(`${res.accepted} row(s) imported to the migration queue.`);
        onDone();
      } else {
        toast.error(
          `${res.rejected.length} row(s) rejected. Fix the flagged lines and re-import.`,
          'Import completed with errors',
        );
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Import failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const rejectCols: Column<ImportResult['rejected'][number]>[] = [
    { key: 'line', header: 'Line', width: '64px', cell: (r) => <span className="tabular-nums">{r.line}</span> },
    { key: 'reason', header: 'Reason', cell: (r) => r.reason },
    { key: 'raw', header: 'Row', mono: true, cell: (r) => r.raw ?? '—' },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title="Bulk CSV import"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Close
          </Button>
          <Button
            variant="primary"
            leftIcon={Upload}
            onClick={() => void submit()}
            loading={submitting}
            loadingLabel="Validating…"
          >
            Validate & import
          </Button>
        </>
      }
    >
      <Banner tone="info" title="Expected columns">
        <span className="mono text-xs">
          SourceEmail, TargetEmail, MigrateExchange, MigrateOneDrive, AutoCreateTarget
        </span>{' '}
        — malformed rows, duplicate source addresses, and unresolvable targets are
        rejected with line numbers before anything is queued.
      </Banner>

      <div className="stack gap-3" style={{ marginTop: 'var(--space-4)' }}>
        <label className="field__label">CSV content</label>
        <textarea
          className="input mono"
          style={{ height: 160, padding: 'var(--space-3)', lineHeight: 1.5, resize: 'vertical' }}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={CSV_TEMPLATE}
          spellCheck={false}
          aria-label="CSV content"
        />
        <div className="row gap-3 wrap">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
            aria-label="Choose CSV file"
          />
          <Button variant="ghost" size="sm" onClick={() => setCsv(CSV_TEMPLATE)}>
            Insert sample
          </Button>
        </div>
      </div>

      {result && (
        <div style={{ marginTop: 'var(--space-6)' }}>
          <div className="row gap-3" style={{ marginBottom: 'var(--space-3)' }}>
            <Badge variant="success">{result.accepted} accepted</Badge>
            <Badge variant={result.rejected.length ? 'error' : 'neutral'} icon={FileWarning}>
              {result.rejected.length} rejected
            </Badge>
          </div>
          {result.rejected.length > 0 && (
            <DataGrid
              columns={rejectCols}
              rows={result.rejected}
              rowKey={(r, i) => `${r.line}-${i}`}
              caption="Rejected CSV rows"
            />
          )}
        </div>
      )}
    </Modal>
  );
}
