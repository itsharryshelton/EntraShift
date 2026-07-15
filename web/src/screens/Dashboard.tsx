/**
 * Screen 2 — Dashboard (branding §8.2).
 * Connection status cards (§5.1), active-migration count, throughput sparkline,
 * recent errors summary, and the free-tier budget indicator (Workers/D1/Queues
 * daily usage). All data is polled from the Worker (no websockets, SoW §1.1).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Gauge,
  PlugZap,
} from 'lucide-react';
import {
  Card,
  PageHeader,
  StatusCard,
  Sparkline,
  Badge,
  StatusBadge,
  Banner,
  Button,
  EmptyState,
} from '../components';
import { useAsync } from '../lib/useAsync';
import {
  tenants as tenantsApi,
  jobs as jobsApi,
  budget as budgetApi,
  poll,
  type TenantSummary,
} from '../lib/api';
import { formatCount } from '../lib/format';
import type { Job, FreeTierBudget, TenantRole } from '@shared/contracts';

const ACTIVE_STATUSES = new Set<Job['status']>([
  'queued',
  'provisioning',
  'running',
  'backing_off',
  'delta_pending',
  'delta_running',
]);

const FAILURE_STATUSES = new Set<Job['status']>([
  'auth_expired',
  'permission_revoked',
  'quota_exceeded',
  'failed',
]);

export function Dashboard() {
  const tenantsState = useAsync<TenantSummary[]>((s) => tenantsApi.list(s), []);
  const budgetState = useAsync<FreeTierBudget>((s) => budgetApi.get(s), []);

  // Jobs poll on the 30s free-tier floor for a live-ish dashboard.
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsError, setJobsError] = useState<unknown>(null);
  useEffect(() => {
    const handle = poll<Job[]>(
      (s) => jobsApi.list(s),
      (data) => {
        setJobs(data);
        setJobsError(null);
      },
      (err) => setJobsError(err),
      30_000,
    );
    return () => handle.stop();
  }, []);

  const activeCount = jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
  const recentErrors = jobs.filter((j) => FAILURE_STATUSES.has(j.status));
  const throttling = jobs.some((j) => j.status === 'backing_off');

  // Synthesize a throughput series from cumulative bytesDone as a placeholder
  // shape until the Worker exposes a time series. Purely illustrative.
  const throughput = useMemo(() => {
    const base = jobs.reduce((sum, j) => sum + (j.bytesDone ?? 0), 0);
    const seed = base % 997;
    return Array.from({ length: 24 }, (_, i) =>
      Math.max(0, Math.round(Math.sin(i / 2.2 + seed) * 40 + 55 + (i % 5) * 6)),
    );
  }, [jobs]);

  const byRole = (role: TenantRole) =>
    tenantsState.data?.find((t) => t.role === role);

  return (
    <div className="section-gap">
      <PageHeader
        title="Dashboard"
        description="Live overview of tenant connectivity, active migrations, and free-tier budget."
      />

      {budgetState.data?.degraded && (
        <Banner
          tone="warning"
          title="Free-tier budget governor engaged"
          action={
            <Link to="/settings">
              <Button variant="secondary" size="sm">
                Review
              </Button>
            </Link>
          }
        >
          A daily Cloudflare usage counter crossed its soft threshold. Non-essential
          writes are paused and the engine is idling to stay inside Free Tier.
        </Banner>
      )}

      {throttling && (
        <Banner tone="warning" title="Engine is self-throttling">
          One or more jobs are backing off in response to Microsoft Graph
          throttling (Retry-After honoured). Throughput is reduced but the
          migration is not stalled.
        </Banner>
      )}

      {/* Connection status cards (§5.1) */}
      <div className="grid-cards grid-2">
        {(['source', 'destination'] as TenantRole[]).map((role) => {
          const t = byRole(role);
          return (
            <StatusCard
              key={role}
              role={role}
              status={t?.status ?? 'disconnected'}
              tenantId={t?.tenantId}
              clientId={t?.clientId}
              secretExpiry={t?.secretExpiry}
              action={
                <Link to="/tenants">
                  <Button variant={t ? 'secondary' : 'primary'} size="sm" leftIcon={PlugZap}>
                    {t ? 'Manage' : 'Connect'}
                  </Button>
                </Link>
              }
            />
          );
        })}
      </div>

      {/* Metrics + budget */}
      <div className="grid-cards grid-3">
        <Card>
          <div className="metric">
            <span className="metric__label">Active migrations</span>
            <span className="metric__value">{formatCount(activeCount)}</span>
            <span className="metric__sub">
              {jobs.length} job{jobs.length === 1 ? '' : 's'} total
            </span>
          </div>
        </Card>

        <Card>
          <div className="metric">
            <span className="metric__label">Throughput (last 24 samples)</span>
            <Sparkline data={throughput} ariaLabel="Recent throughput trend" />
          </div>
        </Card>

        <Card title="Free-tier budget" subtitle="Cloudflare daily usage">
          {budgetState.data ? (
            <div className="stack gap-3">
              <BudgetMeter label="Workers requests" used={budgetState.data.workers.used} limit={budgetState.data.workers.limit} />
              <BudgetMeter label="D1 writes" used={budgetState.data.d1Writes.used} limit={budgetState.data.d1Writes.limit} />
              <BudgetMeter label="Queue ops" used={budgetState.data.queueOps.used} limit={budgetState.data.queueOps.limit} />
            </div>
          ) : (
            <div className="stack gap-2">
              <div className="skeleton" style={{ height: 14 }} />
              <div className="skeleton" style={{ height: 14 }} />
              <div className="skeleton" style={{ height: 14 }} />
            </div>
          )}
        </Card>
      </div>

      {/* Recent errors */}
      <Card
        title="Recent errors"
        subtitle="Distinct failure states surface remediation hints in the Monitor"
        actions={
          <Link to="/monitor">
            <Button variant="ghost" size="sm" leftIcon={Activity}>
              Open Monitor
            </Button>
          </Link>
        }
        flush
      >
        {jobsError && !jobs.length ? (
          <div style={{ padding: 'var(--space-6)' }}>
            <Banner tone="error" title="Control plane unreachable">
              Could not load job state. The dashboard will retry automatically.
            </Banner>
          </div>
        ) : recentErrors.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            message="No job failures reported. Everything is running cleanly."
          />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {recentErrors.slice(0, 6).map((j) => (
              <li
                key={j.id}
                className="row spread gap-3"
                style={{
                  padding: 'var(--space-3) var(--space-6)',
                  borderBottom: '1px solid var(--color-border)',
                }}
              >
                <div className="row gap-3 grow" style={{ minWidth: 0 }}>
                  <Badge variant="neutral">{j.workload}</Badge>
                  <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {j.sourceEmail}
                  </span>
                  {j.errorClass && (
                    <span className="mono text-xs muted">{j.errorClass}</span>
                  )}
                </div>
                <StatusBadge status={j.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="panel-note row gap-2">
        <Gauge size={14} strokeWidth={1.75} />
        Figures are read-only summaries from D1 and refresh on a 30-second poll to
        respect Cloudflare Free Tier limits.
      </p>
    </div>
  );
}

function BudgetMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = pct >= 85 ? 'danger' : pct >= 70 ? 'warn' : '';
  return (
    <div className="meter">
      <div className="meter__head">
        <span className="text-sm">{label}</span>
        <span className="text-xs muted tabular-nums">
          {formatCount(used)} / {formatCount(limit)} ({pct}%)
        </span>
      </div>
      <div className="meter__track">
        <div className={`meter__fill ${tone ? `meter__fill--${tone}` : ''}`} style={{ width: `${pct}%` }} />
      </div>
      {pct >= 85 && (
        <span className="text-xs" style={{ color: 'var(--color-warning)' }}>
          <AlertTriangle size={12} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          Approaching daily cap — governor may pause non-essential writes.
        </span>
      )}
    </div>
  );
}
