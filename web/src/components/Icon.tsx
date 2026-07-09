/**
 * Icon — thin wrapper over lucide-react enforcing the brand icon rules (§6.5):
 * single set (Lucide), stroke width 1.75, standard sizes (16 inline/table,
 * 20 buttons/nav, 24 page headers, 48 empty states).
 */
import type { LucideIcon } from 'lucide-react';

/**
 * Pixel size. Prefer the brand standard steps — 16 inline/table, 20 buttons/nav,
 * 24 page headers, 48 empty states (§6.5) — with 14/18 permitted for dense badges
 * and compact inline glyphs. Kept as `number` so the primitive never blocks a
 * legitimate size; the standard steps are the convention, not a hard type gate.
 */
export type IconSize = number;

interface IconProps {
  icon: LucideIcon;
  size?: IconSize;
  className?: string;
  /** Decorative by default; pass a label to expose it to assistive tech. */
  label?: string;
  color?: string;
}

export function Icon({ icon: Glyph, size = 20, className, label, color }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      className={className}
      color={color}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable={false}
    />
  );
}
