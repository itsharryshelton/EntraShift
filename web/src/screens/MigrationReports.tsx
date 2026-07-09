/**
 * Screen 7 — Migration Reports (branding §8.7, SoW Phase 4).
 *
 * Per-user drill-down: items succeeded / skipped / failed, error classes, data
 * volume, duration, and delta-pass summary — with CSV export. The user picker on
 * the left drives the report panel on the right.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FileBarChart2,
  Download,
  CheckCircle2,
  MinusCircle,
  XCircle,
  ArrowRight,
} from 'lucide-react';
import {
  Card,
  PageHeader,
  Button,
  Badge,
  StatusBadge,
  Banner,
  DataGrid,
  EmptyState,
  WorkloadPill,
  Icon,
  type Column,
} from '../components';
import { useAsync } from '../lib/useAsync';
import { migrationUsers as usersApi, reports as reportsApi } from '../lib/api';
import { formatBytes, formatDuration, formatCount } from '../lib/format';
import type { MigrationUser, PerUserReport } from '@shared/contracts';

export function MigrationReports() {
  const usersState = useAsync<MigrationUser[]>((s) => usersApi.list(s), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const users = usersState.data ?? [];

  // Auto-select the first user once loaded.
  useEffect(() => {
    if (!selectedId && users.length > 0) setSelectedId(users[0]!.id);
  }, [users, selectedId]);

  return (
    <div className="section-gap">
      <PageHeader
        title="Migration Reports"
        description="Per-user outcome breakdown across workloads. Export any report as CSV for handover or record-keeping."
      />

      {usersState.error && (
        <Banner tone="error" title="Could not load users">
          The control plane is unreachable. Reports will appear once it responds.
        </Banner>
      )}

      {!usersState.loading && users.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileBarChart2}
            message="No migrations to report on yet. Queue and run jobs to generate per-user reports."
            action={
              <Link to="/mapping">
                <Button variant="primary" rightIcon={ArrowRight}>
                  Go to Mapping
                </Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid-cards" style={{ gridTemplateColumns: '280px 1fr', gap: 'var(--space-4)' }}>
          <Card title="Users" flush>
            {usersState.loading ? (
              <div style={{ padding: 'var(--space-4)' }}>
                <div className="skeleton" style={{ height: 40, marginBottom: 8 }} />
                <div className="skeleton" style={{ height: 40 }} />
              </div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 'var(--space-2)' }}>
                {users.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      className="list-btn"
                      aria-current={selectedId === u.id ? 'true' : undefined}
                      onClick={() => setSelectedId(u.id)}
                    >
                      <span className="stack" style={{ minWidth: 0, alignItems: 'flex-start' }}>
                        <span className="text-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 210 }}>
                          {u.sourceEmail}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {selectedId ? (
            <ReportPanel migrationUserId={selectedId} />
          ) : (
            <Card>
              <EmptyState icon={FileBarChart2} message="Select a user to view their migration report." />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function ReportPanel({ migrationUserId }: { migrationUserId: string }) {
  const { data, loading, error } = useAsync<PerUserReport>(
    (s) => reportsApi.get(migrationUserId, s),
    [migrationUserId],
  );

  if (loading) {
    return (
      <Card>
        <div className="skeleton" style={{ height: 24, width: 240, marginBottom: 16 }} />
        <div className="skeleton" style={{ height: 120 }} />
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <Banner tone="warning" title="Report unavailable">
          No report data for this user yet, or the control plane is unreachable.
        </Banner>
      </Card>
    );
  }

  const totals = data.workloads.reduce(
    (acc, w) => {
      acc.succeeded += w.itemsSucceeded;
      acc.skipped += w.itemsSkipped;
      acc.failed += w.itemsFailed;
      acc.bytes += w.bytes;
      return acc;
    },
    { succeeded: 0, skipped: 0, failed: 0, bytes: 0 },
  );

  const columns: Column<PerUserReport['workloads'][number]>[] = [
    {
      key: 'workload',
      header: 'Workload',
      cell: (w) => <WorkloadPill workload={w.workload} active />,
    },
    { key: 'status', header: 'Status', cell: (w) => <StatusBadge status={w.status} /> },
    {
      key: 'succeeded',
      header: 'Succeeded',
      cell: (w) => (
        <span className="row gap-1 tabular-nums">
          <Icon icon={CheckCircle2} size={14} color="var(--color-success)" />
          {formatCount(w.itemsSucceeded)}
        </span>
      ),
    },
    {
      key: 'skipped',
      header: 'Skipped',
      cell: (w) => (
        <span className="row gap-1 tabular-nums">
          <Icon icon={MinusCircle} size={14} color="var(--color-warning)" />
          {formatCount(w.itemsSkipped)}
        </span>
      ),
    },
    {
      key: 'failed',
      header: 'Failed',
      cell: (w) => (
        <span className="row gap-1 tabular-nums">
          <Icon icon={XCircle} size={14} color="var(--color-error)" />
          {formatCount(w.itemsFailed)}
        </span>
      ),
    },
    { key: 'bytes', header: 'Volume', cell: (w) => <span className="tabular-nums">{formatBytes(w.bytes)}</span> },
    {
      key: 'duration',
      header: 'Duration',
      cell: (w) => <span className="tabular-nums">{formatDuration(w.durationSec)}</span>,
    },
    {
      key: 'delta',
      header: 'Delta passes',
      cell: (w) => <span className="tabular-nums">{w.deltaPasses}</span>,
    },
  ];

  return (
    <Card
      title={data.sourceEmail}
      subtitle={<span className="mono text-xs">→ {data.targetUpn}</span>}
      actions={
        <a href={reportsApi.exportUrl(migrationUserId)} download>
          <Button variant="secondary" size="sm" leftIcon={Download}>
            Export CSV
          </Button>
        </a>
      }
      flush
    >
      <div className="row gap-3 wrap" style={{ padding: 'var(--space-4) var(--space-6)' }}>
        <Badge variant="success" icon={CheckCircle2}>
          {formatCount(totals.succeeded)} succeeded
        </Badge>
        <Badge variant="warning" icon={MinusCircle}>
          {formatCount(totals.skipped)} skipped
        </Badge>
        <Badge variant="error" icon={XCircle}>
          {formatCount(totals.failed)} failed
        </Badge>
        <Badge variant="neutral">{formatBytes(totals.bytes)} total</Badge>
      </div>
      <DataGrid
        columns={columns}
        rows={data.workloads}
        rowKey={(w) => w.workload}
        caption={`Per-workload report for ${data.sourceEmail}`}
        emptyState={<EmptyState icon={FileBarChart2} message="No workload results recorded for this user." />}
      />
      <p className="prototype-note" style={{ padding: 'var(--space-4) var(--space-6)' }}>
        Skipped/failed items are recorded at item level (item ID, folder path, error
        class) via the engine's skip-and-log; a failed item never fails the whole
        job. Version history is not migrated (latest version only).
      </p>
    </Card>
  );
}
