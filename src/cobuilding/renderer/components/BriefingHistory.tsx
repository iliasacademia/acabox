import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeftIcon, BookOpenIcon, AwardIcon, CalendarIcon, SparklesIcon } from 'lucide-react';

type FilterId = 'all' | 'papers' | 'grants' | 'citations' | 'proactive';

const FILTERS: Array<{ id: FilterId; label: string; types: BriefingType[] | null }> = [
  { id: 'all', label: 'All', types: null },
  { id: 'papers', label: 'Papers', types: ['paper'] },
  { id: 'grants', label: 'Grants', types: ['grant'] },
  { id: 'citations', label: 'Citations', types: ['citation'] },
  { id: 'proactive', label: 'Proactive', types: ['suggested_action', 'suggested_tool'] },
];

const STATUS_LABEL: Record<BriefingStatus, string> = {
  new: 'NEW',
  opened: 'OPENED',
  dismissed: 'DISMISSED',
};

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
  switch (row.briefing.type) {
    case 'suggested_tool':
      return typeof d.name === 'string' ? d.name : 'Suggested mini-app';
    case 'suggested_action':
      return typeof d.title === 'string' ? d.title : 'Suggested action';
    case 'paper':
      return typeof d.title === 'string' ? d.title : 'Paper';
    case 'citation':
      return typeof d.paper_title === 'string' ? d.paper_title : 'Citation';
    case 'grant':
      return typeof d.title === 'string' ? d.title : 'Grant';
  }
}

function rowSubtitle(row: ParsedRow): string {
  const d = row.data;
  switch (row.briefing.type) {
    case 'suggested_tool':
      return 'Mini-app suggestion';
    case 'suggested_action':
      return 'Suggested action';
    case 'paper':
      return Array.isArray(d.authors) ? d.authors.join(', ') : 'Paper';
    case 'citation':
      return typeof d.citing_work === 'string' ? `Cited by ${d.citing_work}` : 'Citation';
    case 'grant':
      return typeof d.agency === 'string' ? d.agency : 'Grant';
  }
}

function rowIcon(type: BriefingType) {
  const cls = 'briefingHistoryRow__icon';
  switch (type) {
    case 'paper':
    case 'citation':
      return <BookOpenIcon className={cls} />;
    case 'grant':
      return <AwardIcon className={cls} />;
    case 'suggested_action':
      return <CalendarIcon className={cls} />;
    case 'suggested_tool':
      return <SparklesIcon className={cls} />;
  }
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

export function BriefingHistory({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [filter, setFilter] = useState<FilterId>('all');

  useEffect(() => {
    window.briefingsAPI.list().then((data) => {
      setRows(parseRows(data));
    });
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const types = FILTERS.find((f) => f.id === filter)?.types ?? null;
    if (!types) return rows;
    return rows.filter((r) => types.includes(r.briefing.type));
  }, [rows, filter]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  return (
    <div className="pageShell">
      <div className="briefingHistoryTopBar">
        <button type="button" className="briefingHistoryTopBar__back" onClick={onBack}>
          <ChevronLeftIcon className="briefingHistoryTopBar__backIcon" />
          Back to home
        </button>
      </div>

      <div className="pageShell__inner briefingHistory">
        <div className="briefingHistory__header">
          <div className="briefingHistory__eyebrow">
            BRIEFING HISTORY &middot; {rangeLabel(rows ?? []).toUpperCase()}
          </div>
          <h1 className="briefingHistory__title">What you&apos;ve seen recently</h1>
          <p className="briefingHistory__subtitle">
            Everything that&apos;s appeared in your briefing, with what you did about it.
          </p>
        </div>

        <div className="briefingHistory__filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`briefingHistoryPill${filter === f.id ? ' briefingHistoryPill--active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {rows === null ? (
          <div className="homeSection__empty">Loading&hellip;</div>
        ) : filtered.length === 0 ? (
          <div className="homeSection__empty">No briefings yet.</div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="briefingHistoryGroup">
              <h2 className="briefingHistoryGroup__label">{group.label}</h2>
              <div className="briefingHistoryGroup__list">
                {group.rows.map((row) => (
                  <div key={row.briefing.id} className="briefingHistoryRow">
                    <div className="briefingHistoryRow__iconWrap">{rowIcon(row.briefing.type)}</div>
                    <div className="briefingHistoryRow__main">
                      <div className="briefingHistoryRow__title">{rowTitle(row)}</div>
                      <div className="briefingHistoryRow__subtitle">{rowSubtitle(row)}</div>
                    </div>
                    <div className={`briefingHistoryRow__status briefingHistoryRow__status--${row.briefing.status}`}>
                      {STATUS_LABEL[row.briefing.status]}
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
