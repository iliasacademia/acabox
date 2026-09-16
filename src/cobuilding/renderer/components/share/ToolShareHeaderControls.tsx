import React, { useState } from 'react';
import { useToolShare } from '../../shareStore';
import { MSymbol } from '../command-desk/MSymbol';
import { SharePublishDialog } from './SharePublishDialog';

/**
 * The tool header's sharing UI (`docs/design/sharing-tickets.md`, ticket
 * U5), extracted out of `MiniAppViewer.tsx` rather than inlined there so it
 * can be mounted and tested on its own — `MiniAppViewer` talks to a dozen
 * other `window.*API`s on mount, which would have to be stubbed just to
 * exercise this one chip/button pair.
 *
 * Two components, not one, because the header's spec puts them in different
 * flex positions: the SHARED chip belongs among the other status chips
 * (before `cdToolHeader__spacer`), the share button among the right-side
 * icon buttons (after it, so it's pushed to the far edge with Rebuild/Chat/
 * More). A single fragment rendered at one call site can't occupy both
 * positions, so `MiniAppViewer` mounts `ToolShareChip` and
 * `ToolShareHeaderControls` separately. Both read the same
 * `useToolShare(dirName)` cache (a `useSyncExternalStore` store that
 * dedupes the underlying fetch — see `shareStore.ts`), so two mounts cost
 * nothing extra and can never disagree.
 */

export interface ToolShareChipProps {
  dirName: string;
}

/** `SHARED` / `SHARED · BEHIND`, or nothing while unpublished/loading. */
export function ToolShareChip({ dirName }: ToolShareChipProps): React.ReactElement | null {
  const { published, behind, loading } = useToolShare(dirName);
  if (published === null || loading) return null;
  return (
    <span className="cdStatusChip">
      {behind && <span className="cdDot cdDot--busy" />}
      {behind ? 'SHARED · BEHIND' : 'SHARED'}
    </span>
  );
}

export interface ToolShareHeaderControlsProps {
  dirName: string;
  appName: string;
}

/**
 * The share icon button plus the publish dialog it opens. The dialog is
 * rendered from here, not lifted into `MiniAppViewer`'s own state, so
 * opening/closing it stays entirely local to this component.
 */
export function ToolShareHeaderControls({ dirName, appName }: ToolShareHeaderControlsProps): React.ReactElement {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="cdIconBtn cdIconBtn--30"
        title="Share…"
        onClick={() => setDialogOpen(true)}
      >
        <MSymbol name="share" size={18} />
      </button>
      {dialogOpen && (
        <SharePublishDialog dirName={dirName} appName={appName} onClose={() => setDialogOpen(false)} />
      )}
    </>
  );
}

export default ToolShareHeaderControls;
