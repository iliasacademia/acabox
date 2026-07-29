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
    // Not pulsing: nothing is happening now, it happened to us earlier.
    case 'interrupted': return 'cdDot--busy';
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
    case 'interrupted':
      // A command outlives the app, so we genuinely don't know how it ended;
      // a kernel run doesn't, so we know it stopped. Say which.
      return status.reason === 'finishedWhileAway' ? 'RAN WHILE CLOSED' : 'INTERRUPTED';
    default: return null;
  }
}

/** Longer explanation for tooltips / the tool header. */
export function toolStatusDetail(status: ToolRuntimeStatus): string | null {
  switch (status.kind) {
    case 'working': return 'This tool is doing something right now.';
    case 'interrupted':
      return status.reason === 'finishedWhileAway'
        ? 'Work was still running when Acabox closed. It kept going, but the result was not recorded — open the tool to check its output.'
        : 'Work was interrupted when Acabox closed and did not finish.';
    default: return null;
  }
}
