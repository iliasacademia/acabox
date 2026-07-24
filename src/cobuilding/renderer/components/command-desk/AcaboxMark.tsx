import React from 'react';
import markSmall from '../../../../assets/brand/acabox-mark-small.svg';
import markMaster from '../../../../assets/brand/acabox-mark-master.svg';

/**
 * The ACABOX "B-box" mark, rendered full-bleed as an <img>. Two masters ship:
 * the small one is optically corrected (squarer lobes, heavier stroke, full-
 * bleed tile) for <=32px, the large one carries the inset tile for bigger
 * placements. `variant` overrides the size-based default. The mark supersedes
 * the old play_arrow chip everywhere.
 */
export function AcaboxMark({
  size = 28,
  variant,
  className,
  style,
}: {
  size?: number;
  variant?: 'small' | 'master';
  className?: string;
  style?: React.CSSProperties;
}) {
  const useSmall = (variant ?? (size <= 32 ? 'small' : 'master')) === 'small';
  return (
    <img
      src={useSmall ? markSmall : markMaster}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
      style={{ display: 'block', ...style }}
    />
  );
}
