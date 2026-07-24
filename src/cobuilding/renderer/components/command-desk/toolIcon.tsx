import React from 'react';
import * as LucideIcons from 'lucide-react';
import { LayoutGridIcon } from 'lucide-react';

/**
 * Mini-app manifests name lucide icons (same resolution idiom as
 * MiniAppsTab/ToolsPage), so instrument cards and pinned-tool rows render
 * lucide for the tool glyph itself; Material Symbols is used for every other
 * Command Desk icon.
 */
export function resolveToolIcon(
  name: string | null,
): React.ComponentType<{ style?: React.CSSProperties; className?: string }> {
  if (!name) return LayoutGridIcon;
  const registry = LucideIcons as unknown as Record<
    string,
    React.ComponentType<{ style?: React.CSSProperties; className?: string }>
  >;
  return registry[`${name}Icon`] ?? registry[name] ?? LayoutGridIcon;
}
