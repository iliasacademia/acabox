import React from 'react';

/**
 * Material Symbols Outlined ligature icon (self-hosted woff2, see
 * commandDesk.css). `name` is the ligature name, e.g. "rocket_launch".
 */
export function MSymbol({
  name,
  size = 18,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={className ? `msi ${className}` : 'msi'}
      style={{ fontSize: size }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}
