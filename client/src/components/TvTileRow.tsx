import React, { useMemo } from 'react';

type Props = {
  /** Fixed pixel width for each tile (used for consistent centering + gutters). */
  itemWidth?: number;
  /** Gap between tiles in px. */
  gap?: number;
  className?: string;
  children: React.ReactNode;
};

/**
 * Horizontal tile row that intentionally behaves like the You vs You “Trend cards” row:
 * - free iOS momentum scrolling (a single flick can travel the whole row)
 * - no scroll-snap / no forced centering
 * - fixed tile widths for consistent layout
 */
export default function TvTileRow({ itemWidth = 220, gap = 14, className = '', children }: Props) {
  const styleVars = useMemo(
    () =>
      ({
        // @ts-expect-error CSS custom props
        '--tileW': `${itemWidth}px`,
        // @ts-expect-error CSS custom props
        '--tileGap': `${gap}px`,
      }) as React.CSSProperties,
    [itemWidth, gap],
  );

  const wrapped = React.Children.toArray(children).map((child, idx) => (
    <div key={(child as any)?.key ?? idx} className="tv-tileRowItem">
      {child}
    </div>
  ));

  return (
    <div className={`tv-tileRow ${className}`} style={styleVars}>
      {wrapped}
    </div>
  );
}
