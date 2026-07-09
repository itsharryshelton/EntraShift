/**
 * Button (§7.1). Variants: primary | secondary | ghost | danger.
 * Loading state keeps the label AND shows an inline spinner (never spinner-only).
 * Disabled = 50% opacity + not-allowed (handled in CSS).
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from './Icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /** Label shown while loading (defaults to children). */
  loadingLabel?: ReactNode;
  leftIcon?: LucideIcon;
  rightIcon?: LucideIcon;
  block?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingLabel,
  leftIcon,
  rightIcon,
  block,
  disabled,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size !== 'md' && `btn--${size}`,
    block && 'btn--block',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const iconSize = size === 'lg' ? 20 : 16;

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span className="btn__spinner" aria-hidden="true" />
      ) : (
        leftIcon && <Icon icon={leftIcon} size={iconSize} />
      )}
      <span>{loading ? (loadingLabel ?? children) : children}</span>
      {!loading && rightIcon && <Icon icon={rightIcon} size={iconSize} />}
    </button>
  );
}
