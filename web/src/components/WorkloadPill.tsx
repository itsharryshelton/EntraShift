/**
 * WorkloadPill (§5.2). Workload glyphs: envelope = Exchange, cloud = OneDrive
 * (§6.5). ACTIVE = Entra Indigo fill + white text. We NEVER put white text on
 * Shift Cyan (fails AA) — the active fill is always indigo.
 *
 * Renders as a <button> when `onToggle` is provided (interactive toggle in the
 * discovery grid), otherwise as a static <span> label (reports / monitor).
 */
import { Mail, Cloud } from 'lucide-react';
import { Icon } from './Icon';
import type { Workload } from '@shared/contracts';

const GLYPH = { exchange: Mail, onedrive: Cloud } as const;
const LABEL = { exchange: 'Exchange', onedrive: 'OneDrive' } as const;

interface WorkloadPillProps {
  workload: Workload;
  active?: boolean;
  onToggle?: (next: boolean) => void;
  disabled?: boolean;
}

export function WorkloadPill({
  workload,
  active = false,
  onToggle,
  disabled,
}: WorkloadPillProps) {
  const classes = `workload-pill ${active ? 'workload-pill--active' : ''}`;
  const content = (
    <>
      <Icon icon={GLYPH[workload]} size={16} />
      {LABEL[workload]}
    </>
  );

  if (!onToggle) {
    return (
      <span className={classes} aria-label={`${LABEL[workload]} workload`}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={classes}
      role="switch"
      aria-checked={active}
      aria-label={`${LABEL[workload]} workload`}
      disabled={disabled}
      onClick={() => onToggle(!active)}
    >
      {content}
    </button>
  );
}
