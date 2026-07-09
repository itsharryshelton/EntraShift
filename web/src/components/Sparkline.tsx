/**
 * Sparkline — lightweight inline throughput chart for the Dashboard. Pure SVG,
 * no charting dependency (keeps the bundle small for an edge-served admin app).
 * The line uses Shift Cyan (a non-text accent — permitted, §5.2) with a faint
 * gradient area fill.
 */
interface SparklineProps {
  data: number[];
  height?: number;
  ariaLabel?: string;
}

export function Sparkline({ data, height = 48, ariaLabel }: SparklineProps) {
  const width = 240;
  if (data.length < 2) {
    return (
      <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
        <line
          x1="0"
          y1={height - 1}
          x2={width}
          y2={height - 1}
          stroke="var(--color-border)"
          strokeWidth="1"
        />
      </svg>
    );
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel ?? 'Throughput sparkline'}
    >
      <defs>
        <linearGradient id="es-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--brand-shift-cyan)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--brand-shift-cyan)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#es-spark)" />
      <path
        d={line}
        fill="none"
        stroke="var(--brand-shift-cyan)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
