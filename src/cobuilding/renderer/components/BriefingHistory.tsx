import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeftIcon, SparklesIcon, ArrowUpRightIcon } from 'lucide-react';
import { ensureAccessibilityPermission } from '../utils/ensureAccessibilityPermission';

interface ParsedRow {
  briefing: Briefing;
  data: Record<string, unknown>;
}

function parseRows(rows: Briefing[]): ParsedRow[] {
  return rows.map((b) => {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(b.briefing_data) as Record<string, unknown>;
    } catch {
      // ignore
    }
    return { briefing: b, data };
  });
}

function rowTitle(row: ParsedRow): string {
  const d = row.data;
  if (typeof d.title === 'string' && d.title.trim()) return d.title;
  if (typeof d.file_path !== 'string') return 'Review Introduction';
  const parts = d.file_path.split('/');
  return parts[parts.length - 1] || d.file_path;
}

function rowDescription(row: ParsedRow): string {
  if (row.briefing.why_im_suggesting_this) return row.briefing.why_im_suggesting_this;
  const d = row.data;
  return typeof d.description === 'string' ? d.description : '';
}

/** Group briefings by relative day label. Keeps insertion (most-recent-first) order. */
function groupByDay(rows: ParsedRow[]): Array<{ label: string; rows: ParsedRow[] }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

  const groups = new Map<string, ParsedRow[]>();
  const order: string[] = [];

  for (const row of rows) {
    const created = new Date(row.briefing.created_at);
    const day = new Date(created);
    day.setHours(0, 0, 0, 0);

    let label: string;
    if (day.getTime() === today.getTime()) {
      label = 'Today';
    } else if (day.getTime() === yesterday.getTime()) {
      label = 'Yesterday';
    } else if (day >= sevenDaysAgo) {
      label = day.toLocaleDateString('en-US', { weekday: 'long' });
    } else {
      label = day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    if (!groups.has(label)) {
      groups.set(label, []);
      order.push(label);
    }
    groups.get(label)!.push(row);
  }

  return order.map((label) => ({ label, rows: groups.get(label)! }));
}

/** Compute a human-readable range label based on the oldest row's age. */
function rangeLabel(rows: ParsedRow[]): string {
  if (rows.length === 0) return 'no items yet';
  const oldest = new Date(rows[rows.length - 1].briefing.created_at);
  const now = Date.now();
  const days = Math.max(1, Math.round((now - oldest.getTime()) / (1000 * 60 * 60 * 24)));
  const count = rows.length;
  const itemWord = count === 1 ? 'item' : 'items';

  if (days <= 1) return `${count} ${itemWord} today`;
  if (days <= 7) return `${count} ${itemWord} in past week`;
  if (days <= 14) return `${count} ${itemWord} in past 2 weeks`;
  if (days <= 31) return `${count} ${itemWord} in past month`;
  return `${count} ${itemWord} in past ${Math.round(days / 30)} months`;
}

const NEXT_STATUS: Record<BriefingStatus, BriefingStatus> = {
  new: 'opened',
  opened: 'dismissed',
  dismissed: 'new',
};

const STATUS_LABEL: Record<BriefingStatus, string> = {
  new: 'NEW',
  opened: 'OPENED',
  dismissed: 'DISMISSED',
};

export function BriefingHistory({
  onBack,
  workspacePath,
}: {
  onBack: () => void;
  workspacePath: string;
}) {
  const [rows, setRows] = useState<ParsedRow[] | null>(null);

  useEffect(() => {
    window.briefingsAPI.list({ type: ['writing_agent'] }).then((data) => {
      setRows(parseRows(data));
    });
  }, []);

  const groups = useMemo(() => groupByDay(rows ?? []), [rows]);

  const handleOpenRow = async (row: ParsedRow) => {
    window.briefingsAPI.setStatus(row.briefing.id, 'opened');
    const d = row.data;
    if (row.briefing.type === 'writing_agent') {
      if (typeof d.file_path !== 'string') return;
      if (!(await ensureAccessibilityPermission())) return;
      const absolutePath = `${workspacePath}/${d.file_path}`;
      const fileUrl = absolutePath.startsWith('file://') ? absolutePath : `file://${absolutePath}`;
      let existingSessions = 0;
      try {
        existingSessions = await window.sessionsAPI.countForDocument(absolutePath);
      } catch (err) {
        console.warn('[WritingAgent] countForDocument failed:', err);
      }
      if (existingSessions === 0 && typeof d.chat_prompt === 'string') {
        try {
          await window.fileMonitorAPI.setOverlayKickoffForDocument(absolutePath, d.chat_prompt);
        } catch (err) {
          console.warn('[WritingAgent] Failed to stash kickoff:', err);
        }
      }
      window.fileMonitorAPI.openFile(fileUrl, 'com.microsoft.Word');
      window.fileMonitorAPI.setDockRightForDocument(absolutePath, true);
    }
  };

  return (
    <div className="pageShell">
      <div className="briefingHistoryTopBar">
        <button type="button" className="briefingHistoryTopBar__back" onClick={onBack}>
          <ChevronLeftIcon className="briefingHistoryTopBar__backIcon" />
          Back to home
        </button>
      </div>

      <div className="pageShell__inner homePageInner">
        <div className="homeHeader">
          <div className="pageShell__stats">BRIEFING HISTORY &middot; {rangeLabel(rows ?? []).toUpperCase()}</div>
          <h1 className="homeHeader__title">What you&apos;ve seen recently</h1>
          <p className="homeHeader__subtitle">
            Everything that&apos;s appeared in your briefing, with what you did about it.
          </p>
        </div>

        {rows === null ? (
          <div className="homeSection__empty">Loading&hellip;</div>
        ) : rows.length === 0 ? (
          <div className="homeSection__empty">No briefings yet.</div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="briefingHistoryGroup">
              <h2 className="briefingHistoryGroup__label">{group.label}</h2>
              <div className="homeBriefingList">
                {group.rows.map((row) => (
                  <div key={row.briefing.id} className="homeBriefingCard homeBriefingCard--action">
                    <div className="homeBriefingCard__eyebrow">
                      <SparklesIcon className="homeBriefingCard__eyebrowIcon" />
                      <span>I can do this for you</span>
                    </div>
                    <h3 className="homeBriefingCard__title">{rowTitle(row)}</h3>
                    <p className="homeBriefingCard__description">
                      {rowDescription(row)}
                    </p>
                    <div className="homeBriefingCard__actions">
                      <button
                        type="button"
                        className="homeBriefingCard__button homeBriefingCard__button--primary"
                        onClick={() => handleOpenRow(row)}
                      >
                        Open in Word
                        <ArrowUpRightIcon className="homeBriefingCard__buttonIcon" />
                      </button>
                      <button
                        type="button"
                        className={`briefingHistoryRow__status briefingHistoryRow__status--${row.briefing.status}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          const next = NEXT_STATUS[row.briefing.status];
                          window.briefingsAPI.setStatus(row.briefing.id, next);
                          setRows((prev) =>
                            prev?.map((r) =>
                              r.briefing.id === row.briefing.id
                                ? { ...r, briefing: { ...r.briefing, status: next } }
                                : r,
                            ) ?? null,
                          );
                        }}
                        title={`Click to change to ${STATUS_LABEL[NEXT_STATUS[row.briefing.status]]}`}
                      >
                        {STATUS_LABEL[row.briefing.status]}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
