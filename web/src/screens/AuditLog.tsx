/**
 * Screen 8 — Audit Log (branding §8.8, SoW Phase 5).
 *
 * Read-only viewer over the D1 audit log. Filter by actor / action / date range,
 * monospace detail column, and CSV export (used before the rolling 90-day
 * retention prune). Every administrative action across the console is recorded
 * server-side with actor UPN + UTC timestamp.
 */
import { useEffect, useState } from 'react';
import { ScrollText, Download, Search, X } from 'lucide-react';
import {
  Card,
  PageHeader,
  Button,
  Input,
  Badge,
  DataGrid,
  EmptyState,
  Icon,
  type Column,
} from '../components';
import { audit, ApiError, type AuditQuery } from '../lib/api';
import { formatDateTimeUtc } from '../lib/format';
import type { AuditEntry, AuditAction } from '@shared/contracts';

// All audit actions from contracts.ts, for the filter dropdown.
const ACTIONS: AuditAction[] = [
  'sign_in',
  'sign_out',
  'tenant_connect',
  'tenant_disconnect',
  'tenant_test',
  'secret_rotate',
  'user_select',
  'csv_import',
  'mapping_change',
  'provision',
  'password_csv_download',
  'job_start',
  'job_cancel',
  'job_retry',
  'config_change',
  'audit_export',
];

// Sensitive/notable actions get a colored badge; the rest are neutral.
const ACTION_VARIANT: Partial<Record<AuditAction, 'warning' | 'error' | 'info'>> = {
  tenant_disconnect: 'error',
  secret_rotate: 'warning',
  password_csv_download: 'error',
  provision: 'info',
  job_cancel: 'warning',
};

export function AuditLog() {
  const [filters, setFilters] = useState<AuditQuery>({});
  const [applied, setApplied] = useState<AuditQuery>({});
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    audit
      .list(applied, controller.signal)
      .then((page) => {
        setEntries(page.items);
        setCursor(page.cursor);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError') return;
        setError(
          e instanceof ApiError ? e.message : 'Could not load the audit log.',
        );
        setEntries([]);
        setLoading(false);
      });
    return () => controller.abort();
  }, [applied]);

  const loadMore = async () => {
    if (!cursor) return;
    try {
      const page = await audit.list({ ...applied, cursor });
      setEntries((prev) => [...prev, ...page.items]);
      setCursor(page.cursor);
    } catch {
      /* silent; the button simply won't advance */
    }
  };

  const columns: Column<AuditEntry>[] = [
    {
      key: 'time',
      header: 'Timestamp (UTC)',
      width: '210px',
      cell: (e) => <span className="mono text-xs">{formatDateTimeUtc(e.createdAt)}</span>,
    },
    {
      key: 'actor',
      header: 'Actor',
      cell: (e) => <span className="text-sm">{e.actorUpn}</span>,
    },
    {
      key: 'action',
      header: 'Action',
      cell: (e) => (
        <Badge variant={ACTION_VARIANT[e.action] ?? 'neutral'}>
          {e.action.replace(/_/g, ' ')}
        </Badge>
      ),
    },
    {
      key: 'target',
      header: 'Target',
      cell: (e) => <span className="text-sm">{e.target ?? '—'}</span>,
    },
    {
      key: 'detail',
      header: 'Detail',
      mono: true,
      cell: (e) => (
        <span className="mono text-xs" style={{ wordBreak: 'break-all' }}>
          {e.detail ?? '—'}
        </span>
      ),
    },
  ];

  const hasFilters = Boolean(filters.actor || filters.action || filters.from || filters.to);

  return (
    <div className="section-gap">
      <PageHeader
        title="Audit Log"
        description="Read-only record of every administrative action. Rolling 90-day retention — export to CSV before pruning."
        actions={
          <a href={audit.exportUrl(applied)} download>
            <Button variant="secondary" leftIcon={Download}>
              Export CSV
            </Button>
          </a>
        }
      />

      <Card flush>
        <form
          className="toolbar"
          style={{ padding: 'var(--space-4) var(--space-6)' }}
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(filters);
          }}
        >
          <div style={{ width: 220 }}>
            <Input
              aria-label="Filter by actor UPN"
              placeholder="Actor UPN…"
              value={filters.actor ?? ''}
              onChange={(e) => setFilters((f) => ({ ...f, actor: e.target.value }))}
            />
          </div>
          <select
            className="select"
            aria-label="Filter by action"
            value={filters.action ?? ''}
            onChange={(e) =>
              setFilters((f) => ({ ...f, action: e.target.value as AuditAction | '' }))
            }
          >
            <option value="">All actions</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <Input
            aria-label="From date"
            type="date"
            value={filters.from ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          />
          <Input
            aria-label="To date"
            type="date"
            value={filters.to ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          />
          <Button type="submit" variant="primary" leftIcon={Search}>
            Apply
          </Button>
          {hasFilters && (
            <Button
              type="button"
              variant="ghost"
              leftIcon={X}
              onClick={() => {
                setFilters({});
                setApplied({});
              }}
            >
              Clear
            </Button>
          )}
        </form>

        {error && (
          <div style={{ padding: '0 var(--space-6) var(--space-4)' }}>
            <Badge variant="error">{error}</Badge>
          </div>
        )}

        <DataGrid
          columns={columns}
          rows={entries}
          rowKey={(e) => e.id}
          loading={loading}
          caption="Audit log entries"
          emptyState={
            <EmptyState
              icon={ScrollText}
              message={
                hasFilters
                  ? 'No audit entries match the current filters.'
                  : 'No audit entries recorded yet.'
              }
            />
          }
        />

        {cursor && !loading && (
          <div className="row" style={{ justifyContent: 'center', padding: 'var(--space-4)' }}>
            <Button variant="secondary" onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        )}
      </Card>

      <p className="panel-note row gap-2">
        <Icon icon={ScrollText} size={14} />
        The engine writes its own structured JSON-lines log on the VM (job
        lifecycle, throttling, item errors). This viewer shows only the
        control-plane audit trail from D1.
      </p>
    </div>
  );
}
