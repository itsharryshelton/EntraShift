/**
 * ProgressBar (§5.3, §9). 6px track, Indigo→Cyan gradient fill, paired with
 * contextual phase text. Exposes role="progressbar" + aria-valuenow; phase text
 * updates via aria-live="polite". Under prefers-reduced-motion the fill is
 * static (handled in CSS). When total is unknown, renders an indeterminate bar.
 */
import { formatBytes } from '../lib/format';

interface ProgressBarProps {
  /** 0–100. Ignored when indeterminate. */
  percent?: number | null;
  /** Contextual phase line, e.g. "Migrating Inbox [1.2 GB / 4.5 GB]". */
  phaseText?: string | null;
  /** Optional byte counters shown on the right of the meta row. */
  bytesDone?: number;
  bytesTotal?: number | null;
  /** Optional item counters. */
  current?: number;
  total?: number | null;
  label?: string;
}

export function ProgressBar({
  percent,
  phaseText,
  bytesDone,
  bytesTotal,
  current,
  total,
  label,
}: ProgressBarProps) {
  const indeterminate = percent == null || total == null;
  const clamped =
    percent == null ? 0 : Math.min(100, Math.max(0, Math.round(percent)));

  const right =
    bytesDone != null
      ? `${formatBytes(bytesDone)}${bytesTotal != null ? ` / ${formatBytes(bytesTotal)}` : ''}`
      : current != null
        ? `${current.toLocaleString()}${total != null ? ` / ${total.toLocaleString()}` : ''} items`
        : indeterminate
          ? 'Estimating…'
          : `${clamped}%`;

  return (
    <div className="progress">
      <div
        className="progress__track"
        role="progressbar"
        aria-label={label ?? phaseText ?? 'Migration progress'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : clamped}
      >
        <div
          className={`progress__fill ${indeterminate ? 'progress__fill--indeterminate' : ''}`}
          style={indeterminate ? undefined : { width: `${clamped}%` }}
        />
      </div>
      {(phaseText || right) && (
        <div className="progress__meta">
          <span className="progress__phase" aria-live="polite">
            {phaseText ?? ' '}
          </span>
          <span className="tabular-nums">{right}</span>
        </div>
      )}
    </div>
  );
}
