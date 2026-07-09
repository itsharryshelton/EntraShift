/**
 * EntraShift logo (branding §2.1): two overlapping geometric nodes — Source and
 * Destination tenants — connected by a directional "shift" arrow. Deliberately
 * NOT derived from Microsoft iconography.
 *
 * The left node uses Entra Indigo, the shift arrow uses Shift Cyan (a non-text
 * accent, which is allowed — §5.2). Scales cleanly; min height 24px (§2.2).
 */

interface LogoProps {
  /** Overall height in px (width scales with the mark). */
  size?: number;
  /** Show the wordmark next to the mark. */
  withWordmark?: boolean;
  /**
   * Render for placement on an always-dark surface (the Console Slate sidebar, which stays
   * dark in BOTH themes). Forces light wordmark + lightened accents so the mark never becomes
   * dark-on-dark in light mode. Leave false on theme-following backgrounds (sign-in, splash).
   */
  onDark?: boolean;
  className?: string;
}

export function Logo({ size = 28, withWordmark = true, onDark = false, className }: LogoProps) {
  // On the always-dark sidebar the wordmark must not follow the theme's text colour
  // (which is dark in light mode → invisible). Pin light colours when onDark.
  const wordColor = onDark ? 'var(--slate-100)' : 'var(--color-text-primary)';
  const shiftColor = onDark ? 'var(--indigo-400)' : 'var(--brand-entra-indigo)';
  const destFill = onDark ? '#1e293b' : 'var(--color-surface)';
  return (
    <span
      className={`es-logo ${className ?? ''}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}
    >
      <svg
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        role="img"
        aria-label="EntraShift"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Source node (indigo, hollow bracket) */}
        <rect
          x="3"
          y="9"
          width="18"
          height="22"
          rx="5"
          stroke="var(--brand-entra-indigo)"
          strokeWidth="2.5"
        />
        {/* Destination node (overlapping, slate/indigo, offset right + down) */}
        <rect
          x="19"
          y="15"
          width="18"
          height="22"
          rx="5"
          fill={destFill}
          stroke="var(--indigo-400)"
          strokeWidth="2.5"
        />
        {/* Directional shift arrow — Shift Cyan (non-text accent, §5.2) */}
        <path
          d="M13 20h10m0 0-4-4m4 4-4 4"
          stroke="var(--brand-shift-cyan)"
          strokeWidth="2.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {withWordmark && (
        <span
          style={{
            fontWeight: 700,
            fontSize: Math.round(size * 0.62),
            letterSpacing: '-0.01em',
            color: wordColor,
          }}
        >
          Entra<span style={{ color: shiftColor }}>Shift</span>
        </span>
      )}
    </span>
  );
}
