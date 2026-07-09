/**
 * EmptyState (§7.2). Centered: 48px muted icon, one-line explanation, one
 * primary action. Never a blank screen.
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from './Icon';

interface EmptyStateProps {
  icon: LucideIcon;
  message: ReactNode;
  /** A single primary action (branding says one action). */
  action?: ReactNode;
}

export function EmptyState({ icon, message, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <Icon icon={icon} size={48} />
      </span>
      <p className="empty-state__text">{message}</p>
      {action}
    </div>
  );
}
