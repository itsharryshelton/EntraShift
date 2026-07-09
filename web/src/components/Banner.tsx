/**
 * Banner (§7.3). Full-width, functional-state colored 4px left border, icon +
 * message, optional action. Auth-expiry and quota warnings persist (no
 * auto-dismiss) — that persistence is the caller's responsibility; this
 * component only shows a close button when `onClose` is provided.
 */
import type { ReactNode } from 'react';
import { Info, CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react';
import { Icon } from './Icon';

export type BannerTone = 'info' | 'success' | 'warning' | 'error';

const TONE_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
} as const;

interface BannerProps {
  tone?: BannerTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** Provide to show a dismiss button. Omit for persistent banners (§7.3). */
  onClose?: () => void;
}

export function Banner({ tone = 'info', title, children, action, onClose }: BannerProps) {
  return (
    <div
      className={`banner banner--${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <span className="banner__icon">
        <Icon icon={TONE_ICON[tone]} size={20} />
      </span>
      <div className="banner__body">
        {title && <div className="banner__title">{title}</div>}
        {children && <div className="banner__message">{children}</div>}
      </div>
      {action && <div className="banner__actions">{action}</div>}
      {onClose && (
        <button
          type="button"
          className="banner__close"
          onClick={onClose}
          aria-label="Dismiss"
        >
          <Icon icon={X} size={16} />
        </button>
      )}
    </div>
  );
}
