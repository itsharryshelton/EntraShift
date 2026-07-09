/** Shared screen header: 24px title (§4), optional description + actions slot. */
import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div
      className="row spread wrap gap-3"
      style={{ marginBottom: 'var(--space-6)', alignItems: 'flex-start' }}
    >
      <div>
        <h1 style={{ fontSize: 'var(--fs-xl)' }}>{title}</h1>
        {description && (
          <p className="muted text-sm" style={{ marginTop: 'var(--space-1)', maxWidth: '70ch' }}>
            {description}
          </p>
        )}
      </div>
      {actions && <div className="row gap-2 wrap">{actions}</div>}
    </div>
  );
}
