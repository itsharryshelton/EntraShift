/**
 * Badge (§6.3 pill, §9). Functional-state variants always pair color with an
 * icon + text (never color alone). Includes a JobStatus → badge mapper used by
 * the Monitor and Reports screens so status styling stays consistent.
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Loader2,
  Pause,
  ShieldAlert,
  KeyRound,
  Ban,
  Gauge,
} from 'lucide-react';
import { Icon } from './Icon';
import type { JobStatus } from '@shared/contracts';

type Variant = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'indigo-solid';

interface BadgeProps {
  variant?: Variant;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}

export function Badge({ variant = 'neutral', icon, children, className }: BadgeProps) {
  return (
    <span className={`badge badge--${variant} ${className ?? ''}`}>
      {icon && <Icon icon={icon} size={14} />}
      {children}
    </span>
  );
}

/* Map every JobStatus (contracts.ts) to a label + variant + icon. */
const STATUS_META: Record<
  JobStatus,
  { label: string; variant: Variant; icon: LucideIcon }
> = {
  queued: { label: 'Queued', variant: 'neutral', icon: Clock },
  provisioning: { label: 'Provisioning', variant: 'info', icon: Loader2 },
  running: { label: 'Running', variant: 'info', icon: Loader2 },
  backing_off: { label: 'Backing off', variant: 'warning', icon: Gauge },
  delta_pending: { label: 'Delta pending', variant: 'neutral', icon: Clock },
  delta_running: { label: 'Delta running', variant: 'info', icon: Loader2 },
  completed: { label: 'Completed', variant: 'success', icon: CheckCircle2 },
  cancelled: { label: 'Cancelled', variant: 'neutral', icon: Ban },
  paused: { label: 'Paused (budget)', variant: 'warning', icon: Pause },
  auth_expired: { label: 'Auth expired', variant: 'error', icon: KeyRound },
  permission_revoked: { label: 'Permission revoked', variant: 'error', icon: ShieldAlert },
  quota_exceeded: { label: 'Quota exceeded', variant: 'error', icon: AlertTriangle },
  failed: { label: 'Failed', variant: 'error', icon: XCircle },
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.failed;
  return (
    <Badge variant={meta.variant} icon={meta.icon}>
      {meta.label}
    </Badge>
  );
}

/** Remediation hint for the distinct failure states (SoW Phase 4). */
export function statusRemediation(status: JobStatus): string | null {
  switch (status) {
    case 'auth_expired':
      return 'The tenant client secret has expired. Rotate it in Tenant Connections, then retry.';
    case 'permission_revoked':
      return 'Admin consent for a required Graph scope was revoked. Re-run the connection test and re-consent.';
    case 'quota_exceeded':
      return 'The destination mailbox or OneDrive quota was exceeded. Increase quota, then retry.';
    default:
      return null;
  }
}
