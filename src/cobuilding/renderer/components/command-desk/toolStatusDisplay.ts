import type { ToolRuntimeStatus } from '../../toolStatusStore';

/**
 * Shared rendering of a tool's runtime status, so the home grid, the rail and
 * the tool tab bar can't drift apart the way RUNNING/SLEEPING did from the
 * build/install states.
 */

export function toolStatusDotClass(status: ToolRuntimeStatus): string {
  switch (status.kind) {
    case 'buildFailed': return 'cdDot--error';
    case 'building':
    case 'installing':
    case 'working': return 'cdDot--busy cdDot--pulse';
    default: return 'cdDot--sleeping';
  }
}

/**
 * The chip text, or null when the tool is idle. Surfaces that only signal news
 * (home cards, rail) render nothing on null; the tool viewer header, which
 * always shows a chip, spells IDLE out itself.
 */
export function toolStatusLabel(status: ToolRuntimeStatus): string | null {
  switch (status.kind) {
    case 'buildFailed': return 'BUILD FAILED';
    case 'building': return 'BUILDING';
    case 'installing': return 'FIRST BOOT';
    case 'working': return 'WORKING';
    default: return null;
  }
}
