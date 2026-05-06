import React, { useState } from 'react';
import { ChevronLeftIcon, BookOpenIcon, BookmarkIcon, QuoteIcon, SearchIcon, SparklesIcon } from 'lucide-react';

interface DigestPaper {
  id: string;
  title: string;
  authors: string;
  venue: string;
  publishedAgo: string;
  relevance: number;
  oneLine: string;
  whyRelevant: string;
  abstract: string;
}

const MOCK_DIGEST: DigestPaper[] = [
  {
    id: 'p1',
    title: 'Substrate stiffness gradients direct YAP nuclear translocation in basal keratinocytes',
    authors: 'Schmidt, K., Yamamoto, R., Goldberg, P.',
    venue: 'Journal of Cell Biology',
    publishedAgo: 'Published 2 days ago',
    relevance: 88,
    oneLine: 'Their stiffness range overlaps yours; live-cell timing data could strengthen your discussion.',
    whyRelevant:
      'This methodology is very close to your PDMS substrate work. Their stiffness range overlaps yours (you tested 1–40 kPa). Their live-cell timing data could inform your discussion section.',
    abstract:
      'The mechanical environment of the basement membrane is heterogeneous, yet how stiffness gradients influence transcription factor localization in epithelial cells remains unclear. Using polyacrylamide gels with controlled stiffness gradients (0.5–50 kPa), we demonstrate that YAP nuclear/cytoplasmic ratios respond to local stiffness within minutes, with single-cell variability driven by F-actin organization. Live-cell imaging reveals that YAP translocation precedes transcriptional changes by 30–45 minutes.',
  },
  {
    id: 'p2',
    title: 'Live-cell imaging of wound closure dynamics in 3D organoid culture',
    authors: 'Park, A., Tanaka, M., Williams, D.',
    venue: 'Developmental Cell',
    publishedAgo: 'Published 4 days ago',
    relevance: 76,
    oneLine: 'Useful methodologically if you ever extend to 3D — your reviewer 2 has asked about this.',
    whyRelevant:
      'A 3D extension of techniques close to yours. Reviewer 2 has asked about 3D extension on your last submission — this paper is a useful reference.',
    abstract:
      'Three-dimensional organoid systems recapitulate aspects of in vivo tissue not captured by 2D models. Here we present a live-cell imaging pipeline for tracking wound closure dynamics in epithelial organoids over 72 hours.',
  },
  {
    id: 'p3',
    title: 'YAP/TAZ regulation of epidermal stem cell behavior in homeostasis',
    authors: 'Reyes, L., Choi, K., Vance, T.',
    venue: 'Cell Reports',
    publishedAgo: 'Published 5 days ago',
    relevance: 71,
    oneLine: 'Adjacent — homeostasis rather than wound healing, but the YAP transcriptional data is useful background.',
    whyRelevant:
      'Adjacent topic (homeostasis vs. wound healing), but the YAP transcriptional data overlaps your discussion of mechanotransduction.',
    abstract:
      'YAP/TAZ activity is required for epidermal stem cell maintenance under homeostatic conditions. We profile transcriptional changes downstream of YAP nuclear localization across the basal compartment.',
  },
  {
    id: 'p4',
    title: 'Optogenetic control of YAP localization reveals temporal coding of mechanical signals',
    authors: 'Tanaka, R., Mishra, P., Lopez-Garcia, J.',
    venue: 'bioRxiv',
    publishedAgo: 'Posted 6 days ago',
    relevance: 64,
    oneLine: 'Optogenetic approach — different toolset, but their temporal coding finding is interesting for your timing data.',
    whyRelevant:
      'Different toolset (optogenetics vs. substrate stiffness), but their temporal coding finding aligns with the timing patterns you observed.',
    abstract:
      'Using LOV-domain optogenetic tools, we drive YAP nuclear translocation on demand and discover that mechanical signals are temporally encoded with ~30 minute resolution.',
  },
];

const TAKEAWAY =
  'Schmidt et al. is the standout — their stiffness range overlaps yours and the live-cell timing data could strengthen your discussion. Park et al. is methodologically interesting if you ever extend to 3D. The other two are more peripheral.';

type FilterMode = 'all' | 'unread' | 'saved' | 'read';

export function PaperMonitorView({ onBack }: { onBack: () => void }) {
  const [openPaperId, setOpenPaperId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('all');
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  const openPaper = openPaperId ? MOCK_DIGEST.find((p) => p.id === openPaperId) ?? null : null;

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
          <span>PAPER MONITOR RUNNING WEEKLY</span>
        </div>

        <h1 className="paperMonitor__title">Recommended for you</h1>
        <p className="paperMonitor__subtitle">
          Papers from your topics, ranked by relevance to your work. Click any paper to see the full breakdown &mdash; chat alongside stays with you.
        </p>

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

        <h2 className="paperMonitor__sectionTitle">
          This week&apos;s digest
          <span className="paperMonitor__sectionMeta">{MOCK_DIGEST.length} papers &middot; Apr 29</span>
        </h2>

        <div className="paperMonitor__takeaway">
          <div className="paperMonitor__takeawayLabel">
            <SparklesIcon style={{ width: 13, height: 13 }} />
            THIS WEEK&apos;S TAKEAWAY
          </div>
          <div className="paperMonitor__takeawayBody">{TAKEAWAY}</div>
        </div>

        <div className="paperMonitor__list">
          {MOCK_DIGEST.map((p) => (
            <button key={p.id} className="paperMonitor__paperCard" onClick={() => setOpenPaperId(p.id)}>
              <div className="paperMonitor__paperHeader">
                <h3 className="paperMonitor__paperTitle">{p.title}</h3>
                <div className="paperMonitor__relevance">
                  <span className="paperMonitor__relevanceLabel">RELEVANCE</span>
                  <span className="paperMonitor__relevanceScore">{p.relevance}</span>
                </div>
              </div>
              <div className="paperMonitor__paperMeta">
                {p.authors} &middot; <em>{p.venue}</em> &middot; {p.publishedAgo}
              </div>
              <div className="paperMonitor__paperOneLine">{p.oneLine}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PaperDetail({
  paper,
  saved,
  onToggleSave,
  onBackToList,
}: {
  paper: DigestPaper;
  saved: boolean;
  onToggleSave: () => void;
  onBackToList: () => void;
}) {
  return (
    <div className="paperMonitor">
      <div className="paperMonitor__scroll">
        <button className="paperMonitor__topBack" onClick={onBackToList}>
          <ChevronLeftIcon style={{ width: 14, height: 14 }} />
          Back to recommendations
        </button>

        <div className="paperMonitor__crumbs paperMonitor__crumbs--detail">
          <BookOpenIcon style={{ width: 13, height: 13 }} />
          <span>PAPER</span>
          <div className="paperMonitor__relevance paperMonitor__relevance--detail">
            <span className="paperMonitor__relevanceLabel">Relevance to your work</span>
            <span className="paperMonitor__relevanceScore">{paper.relevance}</span>
          </div>
        </div>

        <h1 className="paperMonitor__detailTitle">{paper.title}</h1>
        <div className="paperMonitor__detailMeta">
          {paper.authors} &middot; <em>{paper.venue}</em> &middot; {paper.publishedAgo}
        </div>

        <div className="paperMonitor__whyBox">
          <div className="paperMonitor__whyLabel">
            <SparklesIcon style={{ width: 13, height: 13 }} />
            WHY THIS IS RELEVANT TO YOU
          </div>
          <div className="paperMonitor__whyBody">{paper.whyRelevant}</div>
        </div>

        <div className="paperMonitor__sectionLabel">ABSTRACT</div>
        <div className="paperMonitor__abstract">{paper.abstract}</div>

        <button className="paperMonitor__primaryAction">
          <BookOpenIcon style={{ width: 16, height: 16 }} />
          Read full paper
        </button>

        <button className={`paperMonitor__secondaryAction${saved ? ' paperMonitor__secondaryAction--active' : ''}`} onClick={onToggleSave}>
          <BookmarkIcon style={{ width: 14, height: 14 }} />
          {saved ? 'Saved to library' : 'Save to library'}
        </button>

        <button className="paperMonitor__secondaryAction">
          <QuoteIcon style={{ width: 14, height: 14 }} />
          Draft a citation
        </button>

        <button className="paperMonitor__secondaryAction">
          <SearchIcon style={{ width: 14, height: 14 }} />
          Find similar in my library
        </button>
      </div>
    </div>
  );
}
