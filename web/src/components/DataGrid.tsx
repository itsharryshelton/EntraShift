/**
 * DataGrid (§5.2). Zebra striping, 8px/12px cell padding, sticky header,
 * skeleton loading rows (§7.1), and horizontal scroll below 1024px (§6.2) —
 * columns stay intact rather than reflowing.
 *
 * Generic over the row type; columns declare an accessor + optional renderer.
 * Keyboard: the wrapping table is focusable and standard browser table
 * semantics apply; interactive cells render their own focusable controls.
 */
import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell renderer. */
  cell: (row: T, rowIndex: number) => ReactNode;
  /** Monospace column (IDs, tokens). */
  mono?: boolean;
  /** Right-aligned actions column. */
  actions?: boolean;
  width?: string;
}

interface DataGridProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  loading?: boolean;
  skeletonRows?: number;
  /** Caption for screen readers. */
  caption?: string;
  emptyState?: ReactNode;
}

export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 6,
  caption,
  emptyState,
}: DataGridProps<T>) {
  if (!loading && rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className="grid-scroll">
      <table className="data-grid">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={[c.mono && 'mono', c.actions && 'col-actions']
                  .filter(Boolean)
                  .join(' ')}
                style={c.width ? { width: c.width } : undefined}
                scope="col"
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: skeletonRows }).map((_, r) => (
                <tr key={`sk-${r}`}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.mono ? 'mono' : undefined}>
                      <div className="skeleton data-grid__skeleton" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row, r) => (
                <tr key={rowKey(row, r)}>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={[c.mono && 'mono', c.actions && 'col-actions']
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {c.cell(row, r)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
