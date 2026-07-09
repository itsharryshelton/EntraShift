/** Card (§6.3). Optional header with title/subtitle + trailing actions slot. */
import type { ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Remove body padding (for edge-to-edge data grids). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  flush,
  className,
  bodyClassName,
}: CardProps) {
  const hasHeader = title || subtitle || actions;
  return (
    <section className={`card ${className ?? ''}`}>
      {hasHeader && (
        <header className="card__header">
          <div>
            {title && <div className="card__title">{title}</div>}
            {subtitle && <div className="card__subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="row gap-2">{actions}</div>}
        </header>
      )}
      <div
        className={`card__body ${flush ? 'card__body--flush' : ''} ${bodyClassName ?? ''}`}
      >
        {children}
      </div>
    </section>
  );
}
