/**
 * StatusCard (§5.1). Dual-state tenant connection container.
 *  - Disconnected: dashed Border-Gray, empty-state layout urging an OAuth
 *    Enterprise Application handshake.
 *  - Connected: solid 1px Entra Indigo border + inline green "Connected via
 *    App Reg" badge; shows Tenant ID + client-secret expiry date (metadata
 *    only — never the secret itself, per §7.4 / SoW Phase 0).
 */
import type { ReactNode } from 'react';
import { PlugZap, ShieldCheck, ShieldAlert, Database, HardDrive } from 'lucide-react';
import { Icon } from './Icon';
import { Badge } from './Badge';
import { formatDateUtc } from '../lib/format';
import type { TenantRole } from '@shared/contracts';

interface StatusCardProps {
  role: TenantRole;
  status: 'connected' | 'disconnected' | 'error';
  tenantId?: string | null;
  clientId?: string | null;
  secretExpiry?: string | null;
  lastTestedAt?: string | null;
  /** Action slot (Connect / Test / Manage buttons). */
  action?: ReactNode;
}

const ROLE_LABEL: Record<TenantRole, string> = {
  source: 'Source Tenant',
  destination: 'Destination Tenant',
};

export function StatusCard({
  role,
  status,
  tenantId,
  clientId,
  secretExpiry,
  action,
}: StatusCardProps) {
  const roleIcon = role === 'source' ? HardDrive : Database;

  // Expiry proximity: warn within 30 days, error if past.
  let expiryBadge: ReactNode = null;
  if (secretExpiry) {
    const days = Math.floor(
      (new Date(secretExpiry).getTime() - Date.now()) / 86_400_000,
    );
    if (days < 0) {
      expiryBadge = (
        <Badge variant="error" icon={ShieldAlert}>
          Secret expired
        </Badge>
      );
    } else if (days <= 30) {
      expiryBadge = (
        <Badge variant="warning" icon={ShieldAlert}>
          Expires in {days}d
        </Badge>
      );
    }
  }

  return (
    <div className={`status-card status-card--${status}`}>
      <div className="status-card__head">
        <span className="status-card__role">
          <Icon icon={roleIcon} size={20} />
          {ROLE_LABEL[role]}
        </span>
        {status === 'connected' && (
          <Badge variant="success" icon={ShieldCheck}>
            Connected via App Reg
          </Badge>
        )}
        {status === 'error' && (
          <Badge variant="error" icon={ShieldAlert}>
            Connection error
          </Badge>
        )}
      </div>

      {status === 'disconnected' ? (
        <div className="status-card__empty">
          <span className="muted">
            No {role} tenant connected. Trigger an OAuth Enterprise Application
            handshake to link an App Registration.
          </span>
          {action}
        </div>
      ) : (
        <>
          <dl className="status-card__meta">
            <dt>Tenant ID</dt>
            <dd>{tenantId ?? '—'}</dd>
            <dt>Client ID</dt>
            <dd>{clientId ?? '—'}</dd>
            <dt>Secret expiry</dt>
            <dd>{formatDateUtc(secretExpiry)}</dd>
          </dl>
          <div className="row spread gap-3" style={{ marginTop: 'var(--space-4)' }}>
            <div className="row gap-2">{expiryBadge}</div>
            <div className="row gap-2">{action}</div>
          </div>
        </>
      )}
    </div>
  );
}

/** Small icon-forward hint used when no tenant exists at all. */
export function ConnectHint() {
  return (
    <span className="row gap-2 muted text-sm">
      <Icon icon={PlugZap} size={16} />
      Connect a tenant to begin
    </span>
  );
}
