import React, { useEffect, useState, useCallback } from 'react';
import {
  ChevronLeftIcon,
  BookOpenIcon,
  BookmarkIcon,
  QuoteIcon,
  SearchIcon,
  SparklesIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useComposerRuntime } from '@assistant-ui/react';

const SETTINGS_KEY = 'cobuild.paperMonitor.settings';

const DEFAULT_TOPICS = ['wound healing', 'YAP/TAZ', 'mechanotransduction'];

const TAKEAWAY_PLACEHOLDER =
  'Cross-paper triage will appear here once Claude reviews this digest.';

type FilterMode = 'all' | 'unread' | 'saved' | 'read';

function loadConfiguredTopics(): string[] {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_TOPICS;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.topics !== 'string') return DEFAULT_TOPICS;
    const topics = parsed.topics
      .split(',')
      .map((t: string) => t.trim())
      .filter((t: string): t is string => t.length > 0);
    return topics.length > 0 ? topics : DEFAULT_TOPICS;
  } catch {
    return DEFAULT_TOPICS;
  }
}

function formatPublishedAgo(iso: string): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diffMs = Date.now() - ts;
  const day = 24 * 60 * 60 * 1000;
  const days = Math.max(0, Math.floor(diffMs / day));
  if (days === 0) return 'Published today';
  if (days === 1) return 'Published yesterday';
  if (days < 30) return `Published ${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Published ${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `Published ${years} year${years === 1 ? '' : 's'} ago`;
}

function formatFetchedAt(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function PaperMonitorView({ onBack }: { onBack: () => void }) {
  const [topics, setTopics] = useState<string[]>(() => loadConfiguredTopics());
  const [papers, setPapers] = useState<FetchedPaper[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string>('');
  const [errors, setErrors] = useState<{ source: PaperSource; topic: string; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [openPaperId, setOpenPaperId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('all');

  const fetchPapers = useCallback(async () => {
    const currentTopics = loadConfiguredTopics();
    setTopics(currentTopics);
    setLoading(true);
    setLoadError(null);
    try {
      const result = await window.papersAPI.fetch({
        topics: currentTopics,
        maxPerTopic: 5,
        maxTotal: 20,
      });
      setPapers(result.papers);
      setFetchedAt(result.fetchedAt);
      setErrors(result.errors);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLoadError(message);
      setPapers([]);
      setErrors([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPapers();
  }, [fetchPapers]);

  const visiblePapers = filter === 'saved' ? papers.filter((p) => savedIds.has(p.id)) : papers;
  const openPaper = openPaperId ? papers.find((p) => p.id === openPaperId) ?? null : null;

  if (openPaper) {
    return (
      <PaperDetail
        paper={openPaper}
        saved={savedIds.has(openPaper.id)}
        onToggleSave={() => {
          setSavedIds((prev) => {
            const next = new Set(prev);
            if (next.has(openPaper.id)) next.delete(openPaper.id);
            else next.add(openPaper.id);
            return next;
          });
        }}
        onBackToList={() => setOpenPaperId(null)}
      />
    );
  }

  return (
    <div className="paperMonitor">
      <div className="paperMonitor__scroll">
        <button className="paperMonitor__topBack" onClick={onBack}>
          <ChevronLeftIcon style={{ width: 14, height: 14 }} />
          Back to Tools
        </button>

        <div className="paperMonitor__crumbs">
          <BookOpenIcon style={{ width: 13, height: 13 }} />
          <span>PAPERS</span>
          <span>&middot;</span>
          <span>PAPER MONITOR &middot; ARXIV &middot; PUBMED &middot; OPENALEX &middot; BIORXIV</span>
        </div>

        <h1 className="paperMonitor__title">Recommended for you</h1>
        <p className="paperMonitor__subtitle">
          Papers from your topics, fetched from arXiv. Click any paper to see the abstract.
        </p>

        <div className="paperMonitor__filtersRow">
          <div className="paperMonitor__filters">
            {(['all', 'unread', 'saved', 'read'] as FilterMode[]).map((f) => (
              <button
                key={f}
                className={`paperMonitor__filterPill${filter === f ? ' paperMonitor__filterPill--active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <button
            className="paperMonitor__refreshBtn"
            onClick={fetchPapers}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCwIcon style={{ width: 13, height: 13 }} />
            {loading ? 'Fetching…' : 'Refresh'}
          </button>
        </div>

        <h2 className="paperMonitor__sectionTitle">
          This week&apos;s digest
          <span className="paperMonitor__sectionMeta">
            {visiblePapers.length} paper{visiblePapers.length === 1 ? '' : 's'}
            {fetchedAt ? ` · fetched ${formatFetchedAt(fetchedAt)}` : ''}
          </span>
        </h2>

        <div className="paperMonitor__takeaway">
          <div className="paperMonitor__takeawayLabel">
            <SparklesIcon style={{ width: 13, height: 13 }} />
            THIS WEEK&apos;S TAKEAWAY
          </div>
          <div className="paperMonitor__takeawayBody">
            {topics.length > 0
              ? `Topics: ${topics.join(', ')}. ${TAKEAWAY_PLACEHOLDER}`
              : TAKEAWAY_PLACEHOLDER}
          </div>
        </div>

        {loadError && (
          <div className="paperMonitor__errorBox">
            <strong>Could not fetch papers.</strong> {loadError}
          </div>
        )}

        {errors.length > 0 && !loadError && (
          <div className="paperMonitor__errorBox">
            <strong>Some sources failed:</strong>{' '}
            {errors.map((e) => `${e.source}/${e.topic} (${e.message})`).join('; ')}
          </div>
        )}

        {loading && papers.length === 0 ? (
          <div className="paperMonitor__empty">Fetching latest papers from arXiv…</div>
        ) : visiblePapers.length === 0 ? (
          <div className="paperMonitor__empty">
            No papers yet. Adjust your topics in Settings, then click Refresh.
          </div>
        ) : (
          <div className="paperMonitor__list">
            {visiblePapers.map((p) => (
              <button key={p.id} className="paperMonitor__paperCard" onClick={() => setOpenPaperId(p.id)}>
                <div className="paperMonitor__paperHeader">
                  <h3 className="paperMonitor__paperTitle">{p.title}</h3>
                  <div className="paperMonitor__matchedTopic" title="Matched topic">
                    {p.matchedTopic}
                  </div>
                </div>
                <div className="paperMonitor__paperMeta">
                  {p.authorsLine || 'Unknown authors'} &middot; <em>{p.venue}</em>
                  {p.publishedAt ? <> &middot; {formatPublishedAgo(p.publishedAt)}</> : null}
                  {' '}
                  {p.sources.map((s) => (
                    <span key={s} className={`paperMonitor__sourcePill paperMonitor__sourcePill--${s}`}>
                      {s}
                    </span>
                  ))}
                </div>
                {p.abstract ? (
                  <div className="paperMonitor__paperOneLine">
                    {truncate(p.abstract, 240)}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

function PaperDetail({
  paper,
  saved,
  onToggleSave,
  onBackToList,
}: {
  paper: FetchedPaper;
  saved: boolean;
  onToggleSave: () => void;
  onBackToList: () => void;
}) {
  const composer = useComposerRuntime();

  const handleReadFull = () => {
    if (paper.pdfUrl) window.open(paper.pdfUrl, '_blank');
    else if (paper.url) window.open(paper.url, '_blank');
  };

  const sendToChat = useCallback(
    (prompt: string) => {
      composer.setText(prompt);
      composer.send();
    },
    [composer],
  );

  const handleDraftCitation = () => {
    const authors = paper.authorsLine || 'unknown authors';
    sendToChat(
      `Draft a citation for this paper. I can choose the format afterwards — start with APA.\n\n` +
        `Title: ${paper.title}\n` +
        `Authors: ${authors}\n` +
        `Source: ${paper.venue}${paper.publishedAt ? ` · ${paper.publishedAt}` : ''}\n` +
        `arXiv ID: ${paper.externalId}\n` +
        `URL: ${paper.url}`,
    );
  };

  const handleFindSimilar = () => {
    sendToChat(
      `Find papers in my library similar to this one and explain why each is related.\n\n` +
        `Title: ${paper.title}\n` +
        `Abstract: ${paper.abstract || '(no abstract available)'}\n` +
        `Topic: ${paper.matchedTopic}`,
    );
  };

  return (
    <div className="paperMonitor">
      <div className="paperMonitor__scroll">
        <button className="paperMonitor__topBack" onClick={onBackToList}>
          <ChevronLeftIcon style={{ width: 14, height: 14 }} />
          Back to recommendations
        </button>

        <div className="paperMonitor__crumbs paperMonitor__crumbs--detail">
          <BookOpenIcon style={{ width: 13, height: 13 }} />
          <span>PAPER &middot; ARXIV {paper.externalId}</span>
        </div>

        <h1 className="paperMonitor__detailTitle">{paper.title}</h1>
        <div className="paperMonitor__detailMeta">
          {paper.authorsLine || 'Unknown authors'} &middot; <em>{paper.venue}</em>
          {paper.publishedAt ? <> &middot; {formatPublishedAgo(paper.publishedAt)}</> : null}
        </div>

        <div className="paperMonitor__whyBox">
          <div className="paperMonitor__whyLabel">
            <SparklesIcon style={{ width: 13, height: 13 }} />
            MATCHED TOPIC
          </div>
          <div className="paperMonitor__whyBody">{paper.matchedTopic}</div>
        </div>

        <div className="paperMonitor__sectionLabel">ABSTRACT</div>
        <div className="paperMonitor__abstract">
          {paper.abstract || 'No abstract available.'}
        </div>

        <button className="paperMonitor__primaryAction" onClick={handleReadFull}>
          <BookOpenIcon style={{ width: 16, height: 16 }} />
          Read full paper
        </button>

        <button
          className={`paperMonitor__secondaryAction${saved ? ' paperMonitor__secondaryAction--active' : ''}`}
          onClick={onToggleSave}
        >
          <BookmarkIcon style={{ width: 14, height: 14 }} />
          {saved ? 'Saved to library' : 'Save to library'}
        </button>

        <button className="paperMonitor__secondaryAction" onClick={handleDraftCitation}>
          <QuoteIcon style={{ width: 14, height: 14 }} />
          Draft a citation
        </button>

        <button className="paperMonitor__secondaryAction" onClick={handleFindSimilar}>
          <SearchIcon style={{ width: 14, height: 14 }} />
          Find similar in my library
        </button>
      </div>
    </div>
  );
}
