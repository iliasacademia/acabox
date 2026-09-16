import React, { useEffect, useState } from 'react';
import { useToolShare, refreshToolShare } from '../../shareStore';
import type { PublishedInfo, SnapshotGroup, SnapshotSummary } from '../../../shared/share';
import { formatBytes } from './formatBytes';
import './SharePublishDialog.css';

/**
 * The confirm-and-progress modal for publishing/refreshing/unpublishing a
 * mini-app snapshot (`docs/design/sharing.md`; contracts in
 * `docs/design/sharing-tickets.md`, ticket U3). Opened from both the Tools
 * page sharing block (U4) and the tool header's share button (U5), so it
 * knows nothing about where it was launched from beyond `dirName`/`appName`.
 *
 * Reuses the `toolsConfirmOverlay`/`toolsConfirmModal*` markup and classes
 * from `ToolsPage.tsx`'s delete-confirmation modal (App.css) wholesale —
 * this file's own CSS covers only what those don't: the summary table and
 * the mono URL field.
 *
 * Publish status (`published`/`behind`) comes from `useToolShare`, the same
 * store the header chip and the Tools page row read, so this dialog and
 * every other surface agree. `justPublished` is a LOCAL override: right
 * after this dialog's own publish/unpublish call succeeds, we already have
 * the fresher truth in hand and show it immediately rather than waiting for
 * the store's `refreshToolShare` round-trip to land.
 */

export interface SharePublishDialogProps {
  dirName: string;
  appName: string;
  onClose(): void;
}

interface PlanState {
  summary: SnapshotSummary;
  hash: string;
}

function SummaryRow({
  label,
  group,
  notIncluded,
  total,
}: {
  label: string;
  group: SnapshotGroup;
  notIncluded?: boolean;
  total?: boolean;
}): React.ReactElement {
  return (
    <tr className={`sharePublishDialog__row${total ? ' sharePublishDialog__row--total' : ''}`}>
      <td className="sharePublishDialog__rowLabel">{label}</td>
      <td className="sharePublishDialog__rowValue">
        {notIncluded ? 'not included' : `${group.count} file${group.count === 1 ? '' : 's'} · ${formatBytes(group.bytes)}`}
      </td>
    </tr>
  );
}

export const SharePublishDialog: React.FC<SharePublishDialogProps> = ({ dirName, appName, onClose }) => {
  const { published: hookPublished, behind: hookBehind, loading: statusLoading } = useToolShare(dirName);

  // null = "user hasn't touched the checkbox this session" — the effective
  // value then tracks the published record's own choice, so reopening a
  // publish that excluded input data starts unchecked rather than always
  // defaulting to true.
  const [userIncludeInput, setUserIncludeInput] = useState<boolean | null>(null);
  const includeInput = userIncludeInput ?? (hookPublished?.includeInput ?? true);

  const [plan, setPlan] = useState<PlanState | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ uploaded: number; total: number } | null>(null);
  const [justPublished, setJustPublished] = useState<PublishedInfo | null>(null);

  const [unpublishArmed, setUnpublishArmed] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [unpublishError, setUnpublishError] = useState<string | null>(null);

  const [copyFeedback, setCopyFeedback] = useState(false);

  // Plan only once the share status is known. The store reports a key nobody
  // has fetched yet as `loading: true` (see UNKNOWN_STATE in shareStore.ts),
  // so a cold cache waits for the real answer and a cache already warmed by a
  // sibling SHARED chip plans immediately — no latch, no double plan.
  useEffect(() => {
    if (statusLoading) return;
    let cancelled = false;
    setPlanLoading(true);
    setPlanError(null);
    void window.shareAPI.planApp(dirName, includeInput).then((result) => {
      if (cancelled) return;
      setPlanLoading(false);
      if (result.ok) {
        setPlan({ summary: result.summary, hash: result.hash });
      } else {
        setPlan(null);
        setPlanError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dirName, includeInput, statusLoading]);

  // One subscription for the life of the dialog; `onProgress` fires for
  // every in-flight publish across the app, so ignore anything not ours.
  useEffect(() => {
    return window.shareAPI.onProgress((p) => {
      if (p.dirName !== dirName) return;
      setProgress({ uploaded: p.uploaded, total: p.total });
    });
  }, [dirName]);

  const published = justPublished ?? hookPublished;
  const behind = justPublished ? false : hookBehind;

  let title: string;
  if (!published) title = `Publish "${appName}"`;
  else if (behind) title = 'Refresh shared copy';
  else title = 'Shared copy is up to date';

  const busy = publishing || unpublishing;

  const handlePublish = async (): Promise<void> => {
    setPublishing(true);
    setPublishError(null);
    setProgress(null);
    try {
      const result = await window.shareAPI.publishApp(dirName, { includeInput });
      if (result.ok) {
        setJustPublished(result.published);
        setUnpublishArmed(false);
        await refreshToolShare(dirName);
      } else {
        setPublishError(result.error);
      }
    } finally {
      setPublishing(false);
      setProgress(null);
    }
  };

  const handleUnpublishClick = async (): Promise<void> => {
    if (!unpublishArmed) {
      setUnpublishArmed(true);
      return;
    }
    setUnpublishing(true);
    setUnpublishError(null);
    try {
      const result = await window.shareAPI.unpublishApp(dirName);
      if (result.ok) {
        await refreshToolShare(dirName);
        onClose();
      } else {
        setUnpublishError(result.error ?? 'Something went wrong.');
        setUnpublishArmed(false);
      }
    } finally {
      setUnpublishing(false);
    }
  };

  const handleCopyLink = (): void => {
    if (!published) return;
    void navigator.clipboard.writeText(published.url).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    });
  };

  const handleOpen = (): void => {
    if (!published) return;
    void (window as any).electronAPI.invoke('shell:openExternal', published.url);
  };

  const closeLabel = published ? 'Close' : 'Cancel';
  const handleOverlayClose = (): void => {
    if (!busy) onClose();
  };

  return (
    <div className="toolsConfirmOverlay" onClick={handleOverlayClose}>
      <div
        className="toolsConfirmModal sharePublishDialog"
        onClick={(e) => e.stopPropagation()}
      >
        {plan === null && planError === null ? (
          <p className="toolsConfirmModal__message">Loading share status…</p>
        ) : (
          <>
            <h3 className="toolsConfirmModal__title">{title}</h3>

            {planError && (
              <p className="toolsConfirmModal__message toolsConfirmModal__message--error">{planError}</p>
            )}

            {plan && (
              <table className="sharePublishDialog__table">
                <tbody>
                  <SummaryRow label="Code" group={plan.summary.code} />
                  <SummaryRow label="Output" group={plan.summary.output} />
                  <SummaryRow label="Input" group={plan.summary.input} notIncluded={!includeInput} />
                  <SummaryRow label="Vendor" group={plan.summary.vendor} />
                  <SummaryRow label="Total" group={plan.summary.total} total />
                </tbody>
              </table>
            )}

            <label className="sharePublishDialog__checkbox">
              <input
                type="checkbox"
                checked={includeInput}
                disabled={busy}
                onChange={(e) => setUserIncludeInput(e.target.checked)}
              />
              Include input data
            </label>

            {publishing && (
              <p className="toolsConfirmModal__message">
                {progress ? `Uploading ${progress.uploaded} of ${progress.total} files…` : 'Publishing…'}
              </p>
            )}

            {publishError && (
              <p className="toolsConfirmModal__message toolsConfirmModal__message--error">{publishError}</p>
            )}

            {unpublishError && (
              <p className="toolsConfirmModal__message toolsConfirmModal__message--error">{unpublishError}</p>
            )}

            {published && (
              <div className="sharePublishDialog__urlRow">
                <input
                  type="text"
                  readOnly
                  className="sharePublishDialog__urlInput"
                  value={published.url}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button type="button" className="toolRow__secondaryBtn" onClick={handleCopyLink}>
                  {copyFeedback ? 'Copied' : 'Copy link'}
                </button>
                <button type="button" className="toolRow__secondaryBtn" onClick={handleOpen}>
                  Open
                </button>
              </div>
            )}

            <p className="sharePublishDialog__footnote">
              Viewers need an @academia.edu Google account. Everything in the table is uploaded.
            </p>

            <div className="toolsConfirmModal__actions">
              {published && (
                <button
                  type="button"
                  className="toolRow__deleteBtn"
                  onClick={() => void handleUnpublishClick()}
                  disabled={busy}
                >
                  {unpublishing ? 'Unpublishing…' : unpublishArmed ? 'Unpublish — are you sure?' : 'Unpublish'}
                </button>
              )}
              <button
                type="button"
                className="toolRow__secondaryBtn"
                onClick={onClose}
                disabled={busy}
              >
                {closeLabel}
              </button>
              <button
                type="button"
                className="toolRow__primaryBtn"
                onClick={() => void handlePublish()}
                disabled={planLoading || busy || (!!published && !behind)}
              >
                {published ? 'Refresh' : 'Publish'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default SharePublishDialog;
