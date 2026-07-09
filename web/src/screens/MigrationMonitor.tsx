/**
 * Screen 6 — Migration Monitor (branding §8.6, SoW Phase 4).
 *
 * Per-user job rows with phase text + progress bars (§5.3), delta-pass badges,
 * an Amber throttle-state indicator when the engine is backing off, and
 * cancel/retry/delta actions. State is POLLED from D1 every 30s (no websockets)
 * to respect the Cloudflare Free Tier (SoW §1.1) — all progress flows through
 * D1, never back through Queues.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Ban,
  RefreshCw,
  Gauge,
  GitCompareArrows,
  CircleSlash,
} from 'lucide-react';
import {
  Card,
  PageHeader,
  Button,
  Badge,
  StatusBadge,
  statusRemediation,
  ProgressBar,
  Banner,
  ConfirmModal,
  WorkloadPill,
  EmptyState,
  Icon,
  useToast,
} from '../components';
import {
  jobs as jobsApi,
  poll,
  ApiError,
} from '../lib/api';
import { formatRelative, toPercent } from '../lib/format';
import type { Job, JobStatus } from '@shared/contracts';

const TERMINAL = new Set<JobStatus>([
  'completed',
  'cancelled',
  'auth_expired',
  'permission_revoked',
  'quota_exceeded',
  'failed',
]);
const RETRYABLE = new Set<JobStatus>([
  'auth_expired',
  'permission_revoked',
  'quota_exceeded',
  'failed',
  'cancelled',
]);
const DELTA_ELIGIBLE = new Set<JobStatus>(['completed', 'delta_pending']);

export function MigrationMonitor() {
  const toast = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Job | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  useEffect(() => {
    const handle = poll<Job[]>(
      (s) => jobsApi.list(s),
      (data) => {
        setJobs(data);
        setLoading(false);
        setUnreachable(false);
      },
      () => {
        setLoading(false);
        setUnreachable(true);
      },
      30_000,
    );
    return () => handle.stop();
  }, []);

  const throttled = useMemo(() => jobs.filter((j) => j.status === 'backing_off'), [jobs]);
  const failing = useMemo(
    () => jobs.filter((j) => statusRemediation(j.status) != null),
    [jobs],
  );

  const doCancel = async () => {
    if (!cancelTarget) return;
    setActionBusy(cancelTarget.id);
    try {
      await jobsApi.cancel(cancelTarget.id);
      toast.success('Job cancellation requested.');
      setCancelTarget(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Cancel failed.');
    } finally {
      setActionBusy(null);
    }
  };

  const doRetry = async (job: Job) => {
    setActionBusy(job.id);
    try {
      await jobsApi.retry(job.id);
      toast.success('Job re-dispatched.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Retry failed.');
    } finally {
      setActionBusy(null);
    }
  };

  const doDelta = async (job: Job) => {
    setActionBusy(job.id);
    try {
      await jobsApi.delta(job.id);
      toast.success('Delta pass queued.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not queue delta pass.');
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div className="section-gap">
      <PageHeader
        title="Migration Monitor"
        description="Live per-user job state, polled from D1 every 30 seconds. Item-level failures are skipped and logged; they never fail the whole mailbox job."
        actions={
          <Badge variant="neutral" icon={RefreshCw}>
            Auto-refresh · 30s
          </Badge>
        }
      />

      {unreachable && jobs.length === 0 && (
        <Banner tone="error" title="Control plane unreachable">
          Job state could not be loaded. The monitor keeps retrying every 30s.
        </Banner>
      )}

      {throttled.length > 0 && (
        <Banner tone="warning" title={`Engine backing off on ${throttled.length} job(s)`}>
          Microsoft Graph is throttling the migration. The engine is honouring
          Retry-After and self-reducing concurrency. Throughput is temporarily
          reduced — no action needed.
        </Banner>
      )}

      {failing.map((j) => {
        const hint = statusRemediation(j.status);
        return hint ? (
          <Banner key={j.id} tone="error" title={`${j.sourceEmail} — ${j.status.replace('_', ' ')}`}>
            {hint}
          </Banner>
        ) : null;
      })}

      {loading ? (
        <div className="grid-cards" style={{ gap: 'var(--space-4)' }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <div className="skeleton" style={{ height: 60 }} />
            </Card>
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <Card>
          <EmptyState
            icon={Activity}
            message="No migration jobs yet. Queue jobs from Mapping & Provisioning to see live progress here."
            action={
              <Link to="/mapping">
                <Button variant="primary">Go to Mapping</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid-cards" style={{ gap: 'var(--space-4)' }}>
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              busy={actionBusy === job.id}
              onCancel={() => setCancelTarget(job)}
              onRetry={() => void doRetry(job)}
              onDelta={() => void doDelta(job)}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        open={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        onConfirm={doCancel}
        loading={actionBusy === cancelTarget?.id}
        title="Cancel migration job"
        confirmLabel="Cancel job"
        consequence={
          <>
            Cancelling the <strong>{cancelTarget?.workload}</strong> job for{' '}
            <strong>{cancelTarget?.sourceEmail}</strong> stops the current pass. Items
            already migrated remain in the destination; the job can be retried later
            and will resume from its last checkpoint.
          </>
        }
      />
    </div>
  );
}

function JobRow({
  job,
  busy,
  onCancel,
  onRetry,
  onDelta,
}: {
  job: Job;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onDelta: () => void;
}) {
  const pct = toPercent(job.progressCurrent, job.progressTotal);
  const isTerminal = TERMINAL.has(job.status);
  const canCancel = !isTerminal;
  const canRetry = RETRYABLE.has(job.status);
  const canDelta = DELTA_ELIGIBLE.has(job.status);
  const backingOff = job.status === 'backing_off';

  return (
    <Card>
      <div className="stack gap-3">
        <div className="row spread gap-3 wrap">
          <div className="row gap-3" style={{ minWidth: 0 }}>
            <WorkloadPill workload={job.workload} active />
            <div className="stack" style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 500 }}>{job.sourceEmail}</span>
              <span className="text-xs muted mono">→ {job.targetUpn}</span>
            </div>
          </div>
          <div className="row gap-2 wrap">
            {backingOff && (
              <Badge variant="warning" icon={Gauge}>
                Throttled — backing off
              </Badge>
            )}
            {/* Job (contracts.ts) carries a delta token, not a pass count —
                a stored token means a full pass completed and an incremental
                delta pass can resume from it. */}
            {job.deltaToken && (
              <Badge variant="indigo-solid" icon={GitCompareArrows}>
                Delta ready
              </Badge>
            )}
            <StatusBadge status={job.status} />
          </div>
        </div>

        <ProgressBar
          percent={pct}
          total={job.progressTotal}
          current={job.progressCurrent}
          phaseText={job.phaseText ?? statusPhase(job.status)}
          bytesDone={job.bytesDone}
          bytesTotal={job.bytesTotal}
          label={`${job.workload} migration for ${job.sourceEmail}`}
        />

        <div className="row spread gap-3 wrap">
          <span className="text-xs muted">
            {job.attempts > 0 && `Attempt ${job.attempts} · `}
            Updated {formatRelative(job.updatedAt)}
            {job.errorClass && (
              <>
                {' · '}
                <span className="mono" style={{ color: 'var(--color-error)' }}>
                  {job.errorClass}
                </span>
              </>
            )}
          </span>
          <div className="row gap-2">
            {canDelta && (
              <Button variant="ghost" size="sm" leftIcon={GitCompareArrows} disabled={busy} onClick={onDelta}>
                Delta pass
              </Button>
            )}
            {canRetry && (
              <Button variant="secondary" size="sm" leftIcon={RefreshCw} loading={busy} onClick={onRetry}>
                Retry
              </Button>
            )}
            {canCancel && (
              <Button variant="ghost" size="sm" leftIcon={Ban} disabled={busy} onClick={onCancel}>
                Cancel
              </Button>
            )}
            {isTerminal && !canRetry && !canDelta && (
              <span className="row gap-1 text-xs muted">
                <Icon icon={CircleSlash} size={14} />
                No actions
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Fallback phase text when the engine hasn't written one yet. */
function statusPhase(status: JobStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued — awaiting engine pickup';
    case 'provisioning':
      return 'Provisioning target / OneDrive site…';
    case 'running':
      return 'Full pass in progress…';
    case 'backing_off':
      return 'Backing off (Graph throttling)…';
    case 'delta_pending':
      return 'Full pass complete — awaiting delta';
    case 'delta_running':
      return 'Delta pass in progress…';
    case 'completed':
      return 'Migration complete';
    case 'paused':
      return 'Paused by budget governor';
    default:
      return '';
  }
}
