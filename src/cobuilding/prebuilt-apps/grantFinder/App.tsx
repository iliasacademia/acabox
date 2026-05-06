import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import './grants.css';

declare const window: Window & {
  academiaAPI: {
    fetch(method: string, endpoint: string, data?: unknown): Promise<unknown>;
    setComposerText(text: string): Promise<unknown>;
  };
};

const BASE = 'v0/grants_ai';

function api(method: string, endpoint: string, data?: unknown) {
  return window.academiaAPI.fetch(method, endpoint, data) as Promise<any>;
}

// ── Types ──────────────────────────────────────────────────

interface GrantProject {
  id: number;
  name: string;
  research_summary?: string;
  created_at: string;
}

interface GrantOpportunity {
  id: number;
  name: string;
  funding_organization: string;
  funder_type?: string;
  experience_level?: string;
  description: string;
  deadline: string | null;
  source_url?: string;
  award_amount: string | null;
  score: number;
  rationale?: string;
  how_to_improve?: string;
  last_visited?: string | null;
  favorite?: boolean;
  hidden?: boolean;
  hidden_reason?: string | null;
}

interface ProjectDetail {
  id: number;
  name: string;
  research_summary?: string;
  grant_opportunities: GrantOpportunity[];
  saved_grant_opportunities: GrantOpportunity[];
}

type SidebarSection = 'funding_opportunities' | 'saved_opportunities' | 'search_criteria';

// ── Helpers ────────────────────────────────────────────────

function formatCurrency(amount: string | null): string {
  if (!amount) return '';
  const num = parseFloat(amount.replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return amount;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(num);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function scoreRange(score: number): 'high' | 'medium' | 'low' {
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function scoreTooltip(range: 'high' | 'medium' | 'low'): string {
  switch (range) {
    case 'high':
      return 'We think this is a great match for you';
    case 'medium':
      return 'We think this is an okay match for you';
    case 'low':
      return 'We do not think this is a good match for you';
  }
}

// ── Icons (inline SVGs) ────────────────────────────────────

function ArrowBackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function FolderOpenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function PlusIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function CheckIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CloseIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function BookmarkIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

function ControlCameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v4m0 12v4M2 12h4m12 0h4" />
    </svg>
  );
}

function ArrowForwardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

// ── RelevanceScoreBadge ────────────────────────────────────

function RelevanceScoreBadge({ score }: { score: number }) {
  const range = scoreRange(score);
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <span
      className={`gf-scoreBadge gf-scoreBadge--${range}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {score}/10
      {showTooltip && (
        <span className={`gf-scoreBadge__tooltip gf-scoreBadge__tooltip--${range}`}>
          {scoreTooltip(range)}
        </span>
      )}
    </span>
  );
}

// ── FilterPill ─────────────────────────────────────────────

function FilterPill({
  label,
  options,
  selected,
  onApply,
}: {
  label: string;
  options: string[];
  selected: string[];
  onApply: (selected: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState<string[]>(selected);
  const active = selected.length > 0;

  useEffect(() => {
    if (open) setLocal(selected);
  }, [open, selected]);

  const toggle = (val: string) => {
    setLocal((prev) =>
      prev.includes(val) ? prev.filter((v) => v !== val) : [...prev, val],
    );
  };

  return (
    <div className="gf-filterPill">
      <button
        className={`gf-filterPill__btn${active ? ' gf-filterPill__btn--active' : ''}`}
        onClick={() => setOpen(!open)}
      >
        <span>{label}</span>
        {active ? (
          <span className="gf-filterPill__count">{selected.length}</span>
        ) : (
          <PlusIcon size={16} />
        )}
      </button>
      {open && (
        <>
          <div className="gf-filterPill__overlay" onClick={() => setOpen(false)} />
          <div className="gf-filterPill__dropdown">
            {options.map((opt) => (
              <button
                key={opt}
                className="gf-filterPill__option"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(opt);
                }}
              >
                <div
                  className={`gf-filterPill__checkbox${local.includes(opt) ? ' gf-filterPill__checkbox--checked' : ''}`}
                >
                  {local.includes(opt) && <CheckIcon />}
                </div>
                <span className="gf-filterPill__optionLabel">{opt}</span>
              </button>
            ))}
            <div className="gf-filterPill__actions">
              <button className="gf-filterPill__resetBtn" onClick={() => setLocal([])}>
                Reset
              </button>
              <button
                className="gf-filterPill__saveBtn"
                onClick={() => {
                  onApply(local);
                  setOpen(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── GrantFilters ───────────────────────────────────────────

function GrantFilters({
  funderTypes,
  experienceLevels,
  selectedFunders,
  selectedLevels,
  onFunderChange,
  onLevelChange,
}: {
  funderTypes: string[];
  experienceLevels: string[];
  selectedFunders: string[];
  selectedLevels: string[];
  onFunderChange: (v: string[]) => void;
  onLevelChange: (v: string[]) => void;
}) {
  const hasFilters = selectedFunders.length > 0 || selectedLevels.length > 0;

  const removeChip = (type: 'funder' | 'level', val: string) => {
    if (type === 'funder') onFunderChange(selectedFunders.filter((v) => v !== val));
    else onLevelChange(selectedLevels.filter((v) => v !== val));
  };

  const clearAll = () => {
    onFunderChange([]);
    onLevelChange([]);
  };

  return (
    <div className="gf-filters">
      <div className="gf-filters__row">
        <span className="gf-filters__icon">
          <SlidersIcon />
        </span>
        {funderTypes.length > 0 && (
          <FilterPill
            label="Funding type"
            options={funderTypes}
            selected={selectedFunders}
            onApply={onFunderChange}
          />
        )}
        {experienceLevels.length > 0 && (
          <FilterPill
            label="Experience level"
            options={experienceLevels}
            selected={selectedLevels}
            onApply={onLevelChange}
          />
        )}
      </div>
      {hasFilters && (
        <div className="gf-selectedFilters">
          {selectedFunders.map((v) => (
            <button key={`f-${v}`} className="gf-selectedChip" onClick={() => removeChip('funder', v)}>
              <span>{v}</span>
              <CloseIcon size={14} />
            </button>
          ))}
          {selectedLevels.map((v) => (
            <button key={`l-${v}`} className="gf-selectedChip" onClick={() => removeChip('level', v)}>
              <span>{v}</span>
              <CloseIcon size={14} />
            </button>
          ))}
          <button className="gf-clearAll" onClick={clearAll}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

// ── StatusCountCards ───────────────────────────────────────

function StatusCountCards({
  matchCount,
  savedCount,
}: {
  matchCount: number;
  savedCount: number;
}) {
  const cards = [
    { label: 'MATCHES', count: matchCount },
    { label: 'SAVED', count: savedCount },
    { label: 'IN PROGRESS', count: 0 },
    { label: 'SUBMITTED', count: 0 },
    { label: 'FUNDED', count: 0 },
  ];
  return (
    <div className="gf-statusCards">
      {cards.map((c) => (
        <div key={c.label} className="gf-statusCard">
          <div className="gf-statusCard__label">{c.label}</div>
          <div className="gf-statusCard__count">{c.count}</div>
        </div>
      ))}
    </div>
  );
}

// ── OpportunityCard ────────────────────────────────────────

function OpportunityCard({
  opp,
  projectId,
  onAction,
}: {
  opp: GrantOpportunity;
  projectId: number;
  onAction: () => void;
}) {
  const [fadingOut, setFadingOut] = useState(false);
  const [favorite, setFavorite] = useState(opp.favorite ?? false);
  const [acting, setActing] = useState('');

  useEffect(() => {
    setFavorite(opp.favorite ?? false);
  }, [opp.favorite]);

  const doAction = async (action: 'favorite' | 'hide' | 'visit', value?: boolean) => {
    setActing(action);
    try {
      if (action === 'favorite') {
        const newVal = value ?? !favorite;
        await api('PATCH', `${BASE}/set_favorite_grant_opportunity`, {
          project_id: projectId,
          grant_opportunity_id: opp.id,
          favorite: newVal,
        });
        setFavorite(newVal);
        onAction();
      } else if (action === 'hide') {
        setFadingOut(true);
        await api('PATCH', `${BASE}/set_hidden_grant_opportunity`, {
          project_id: projectId,
          grant_opportunity_id: opp.id,
          hidden: true,
        });
        setTimeout(onAction, 300);
      } else if (action === 'visit') {
        await api('PATCH', `${BASE}/visit_grant_opportunity`, {
          project_id: projectId,
          grant_opportunity_id: opp.id,
        });
        if (opp.source_url) (window as any).academiaAPI.openExternal(opp.source_url);
        onAction();
      }
    } catch {
      // ignore
    } finally {
      setActing('');
    }
  };

  const isNew = !opp.last_visited;
  const formattedAmount = formatCurrency(opp.award_amount);

  return (
    <div className="gf-oppCard__wrapper">
      {isNew && <span className="gf-newBadge">NEW</span>}
      <div className={`gf-oppCard${fadingOut ? ' gf-oppCard--fadingOut' : ''}`}>
        <div className="gf-oppCard__header">
          <div className="gf-oppCard__nameRow">
            <div className="gf-oppCard__nameContainer">
              <h3 className="gf-oppCard__name">{opp.name}</h3>
              <div className="gf-oppCard__org">{opp.funding_organization}</div>
            </div>
          </div>

          <div className="gf-oppCard__stats">
            <div className="gf-oppCard__stat">
              <div className="gf-oppCard__statLabel">Relevancy score</div>
              <RelevanceScoreBadge score={opp.score} />
            </div>
            <div className="gf-oppCard__stat">
              <div className="gf-oppCard__statLabel">Due date</div>
              <div className="gf-oppCard__statValue">
                {opp.deadline ? formatDate(opp.deadline) : 'Refer to source'}
              </div>
            </div>
            <div
              className="gf-oppCard__stat"
              style={{ opacity: formattedAmount ? 1 : 0 }}
            >
              <div className="gf-oppCard__statLabel">Award amount</div>
              <div className="gf-oppCard__statValue">
                {formattedAmount || 'Varies'}
              </div>
            </div>
          </div>
        </div>

        <div className="gf-oppCard__body">
          {opp.description && (
            <p>
              <strong>Description:</strong> {opp.description}
            </p>
          )}
          {opp.rationale && (
            <p>
              <strong>Relevance:</strong> {opp.rationale}
            </p>
          )}
          {opp.how_to_improve && (
            <p>
              <strong>Modification required:</strong> {opp.how_to_improve}
            </p>
          )}
          {opp.source_url && (
            <button className="gf-oppCard__viewLink" onClick={() => doAction('visit')}>
              View opportunity <ExternalLinkIcon />
            </button>
          )}
        </div>

        <div className="gf-oppCard__actions">
          {!favorite && (
            <button
              className="gf-oppCard__notAFit"
              onClick={() => doAction('hide')}
              disabled={acting === 'hide'}
            >
              {acting === 'hide' ? 'Hiding...' : 'Not a fit'}
            </button>
          )}
          <div className="gf-oppCard__actionBtns">
            <button
              className={`gf-btn gf-btn--secondary${favorite ? ' gf-btn--saved' : ''}`}
              onClick={() => doAction('favorite', !favorite)}
              disabled={acting === 'favorite'}
            >
              <BookmarkIcon filled={favorite} />
              <span>{favorite ? 'Saved' : 'Save for later'}</span>
            </button>
            {opp.source_url && (
              <button className="gf-btn gf-btn--primary" onClick={() => doAction('visit')}>
                <span>Check my eligibility</span>
                <ArrowForwardIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ProjectSidebar ─────────────────────────────────────────

function ProjectSidebar({
  project,
  activeSection,
  onSectionChange,
  onBack,
  isLoading,
}: {
  project: GrantProject;
  activeSection: SidebarSection;
  onSectionChange: (s: SidebarSection) => void;
  onBack: () => void;
  isLoading?: boolean;
}) {
  const [width, setWidth] = useState(256);
  const dragging = useRef(false);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const newWidth = Math.min(Math.max(e.clientX, 180), 480);
      setWidth(newWidth);
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <aside className="gf-sidebar" style={{ width, minWidth: width }}>
      <button className="gf-sidebar__item gf-sidebar__item--l1" onClick={onBack}>
        <span className="gf-sidebar__itemContent">
          <ArrowBackIcon />
          <span className="gf-sidebar__itemText gf-sidebar__itemText--bold">All funding searches</span>
        </span>
      </button>

      <div className="gf-sidebar__sectionLabel">Current search</div>

      <div className="gf-sidebar__item gf-sidebar__item--l1 gf-sidebar__item--nonclick">
        <span className="gf-sidebar__itemContent">
          <FolderOpenIcon />
          <span className="gf-sidebar__itemText gf-sidebar__itemText--bold gf-sidebar__itemText--ellipsis">
            {project.name}
          </span>
          {isLoading && <span className="gf-spinner gf-spinner--sm" />}
        </span>
      </div>

      <nav className="gf-sidebar__children">
        <button
          className={`gf-sidebar__item gf-sidebar__item--l2${activeSection === 'funding_opportunities' ? ' gf-sidebar__item--active' : ''}`}
          onClick={() => onSectionChange('funding_opportunities')}
        >
          <span className="gf-sidebar__itemContent">
            <span className="gf-sidebar__itemText">Funding matches</span>
          </span>
        </button>
        <button
          className={`gf-sidebar__item gf-sidebar__item--l2${activeSection === 'saved_opportunities' ? ' gf-sidebar__item--active' : ''}`}
          onClick={() => onSectionChange('saved_opportunities')}
        >
          <span className="gf-sidebar__itemContent">
            <span className="gf-sidebar__itemText">Saved</span>
          </span>
        </button>
      </nav>

      <button
        className={`gf-sidebar__item gf-sidebar__item--l1${activeSection === 'search_criteria' ? ' gf-sidebar__item--active' : ''}`}
        onClick={() => onSectionChange('search_criteria')}
      >
        <span className="gf-sidebar__itemContent">
          <SearchIcon />
          <span className="gf-sidebar__itemText gf-sidebar__itemText--bold">Search settings</span>
        </span>
      </button>

      <div className="gf-sidebar__resizeHandle" onMouseDown={startResize} />
    </aside>
  );
}

// ── SearchSettings ─────────────────────────────────────────

function SearchSettings({
  project,
  researchSummary,
  onUpdateSummary,
}: {
  project: GrantProject;
  researchSummary: string;
  onUpdateSummary: (summary: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [summary, setSummary] = useState(researchSummary);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const MAX_LENGTH = 3000;
  const hasError = summary.length > MAX_LENGTH;

  useEffect(() => {
    setSummary(researchSummary);
  }, [researchSummary]);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      textareaRef.current.focus();
    }
  }, [isEditing]);

  const handleSave = async () => {
    if (hasError) return;
    setSaving(true);
    try {
      // Note: in standalone app we don't have an updateProject endpoint,
      // so we just update locally
      onUpdateSummary(summary);
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="gf-searchSettings">
      <p className="gf-searchSettings__header">
        The more context we have about your research profile, the more relevant funding
        opportunities we can find for you.{' '}
        <strong>
          Any changes made will not impact your current matches. Changes will take effect in
          your next batch of opportunity matches.
        </strong>
      </p>

      {isEditing ? (
        <div className="gf-searchSettings__editSection">
          <label className="gf-label">Summary of your research</label>
          <textarea
            ref={textareaRef}
            className={`gf-textarea gf-textarea--auto${hasError ? ' gf-textarea--error' : ''}`}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
          <div className="gf-searchSettings__charCount">
            <span className={hasError ? 'gf-searchSettings__charCount--error' : ''}>
              {summary.length}
            </span>
            /{MAX_LENGTH}
          </div>
          {hasError && (
            <div className="gf-error">Summary cannot be more than {MAX_LENGTH} characters</div>
          )}
          <p className="gf-searchSettings__hint">
            Your updated summary will be used in all future searches.
          </p>
          <button
            className="gf-btn gf-btn--primary gf-btn--sm"
            onClick={handleSave}
            disabled={hasError || saving}
          >
            Save
          </button>
        </div>
      ) : (
        <>
          <div className="gf-searchSettings__sectionHeader">Summary of your research</div>
          <p className="gf-searchSettings__summaryText">{summary || 'No summary provided.'}</p>
          <button className="gf-btn gf-btn--primary gf-btn--sm" onClick={() => setIsEditing(true)}>
            <EditIcon /> Edit summary
          </button>
        </>
      )}
    </div>
  );
}

// ── SavedEmptyState ────────────────────────────────────────

function SavedEmptyState({ onViewMatches }: { onViewMatches: () => void }) {
  return (
    <div className="gf-emptyState">
      <h2 className="gf-emptyState__title">Nothing saved yet</h2>
      <p className="gf-emptyState__text">
        Save your matches so you can easily find them again. Think of it as bookmarking the
        ones you don't want to lose track of.
      </p>
      <button className="gf-btn gf-btn--primary" onClick={onViewMatches}>
        <span>See your funding matches</span>
        <ArrowForwardIcon />
      </button>
    </div>
  );
}

// ── ProjectDetailView ──────────────────────────────────────

function ProjectDetailView({
  project,
  onBack,
}: {
  project: GrantProject;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<SidebarSection>('funding_opportunities');
  const [selectedFunders, setSelectedFunders] = useState<string[]>([]);
  const [selectedLevels, setSelectedLevels] = useState<string[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCountRef = useRef(0);

  const fetchDetail = useCallback(async () => {
    try {
      const d = await api('GET', `${BASE}/get_project?id=${encodeURIComponent(project.id)}`);
      setDetail(d);
      return d;
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
    return null;
  }, [project.id]);

  const schedulePoll = useCallback(() => {
    const delay = Math.min(Math.pow(2, pollCountRef.current) * 1000, 30_000);
    pollRef.current = setTimeout(async () => {
      pollCountRef.current++;
      await fetchDetail();
      const ageMs = Date.now() - new Date(project.created_at).getTime();
      if (ageMs < 5 * 60_000 && pollCountRef.current < 20) {
        schedulePoll();
      } else {
        setIsPolling(false);
      }
    }, delay);
  }, [fetchDetail, project.created_at]);

  useEffect(() => {
    fetchDetail().then((d) => {
      if (!d) return;
      const ageMs = Date.now() - new Date(project.created_at).getTime();
      if (ageMs < 5 * 60_000) {
        setIsPolling(true);
        pollCountRef.current = 0;
        schedulePoll();
      }
    });
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [fetchDetail, project.created_at, schedulePoll]);

  const opportunities = useMemo(
    () => detail?.grant_opportunities ?? [],
    [detail],
  );
  const saved = useMemo(
    () => detail?.saved_grant_opportunities ?? [],
    [detail],
  );

  const funderTypes = useMemo(
    () => [...new Set(opportunities.map((o) => o.funder_type).filter(Boolean))] as string[],
    [opportunities],
  );
  const expLevels = useMemo(
    () => [...new Set(opportunities.map((o) => o.experience_level).filter(Boolean))] as string[],
    [opportunities],
  );

  const sortedOpportunities = useMemo(() => {
    return [...opportunities].sort((a, b) => {
      if (!a.last_visited && b.last_visited) return -1;
      if (a.last_visited && !b.last_visited) return 1;
      return (b.score || 0) - (a.score || 0);
    });
  }, [opportunities]);

  const visibleOpps = activeSection === 'saved_opportunities' ? saved : sortedOpportunities;

  const filtered = useMemo(() => {
    return visibleOpps.filter((o) => {
      if (selectedFunders.length > 0 && o.funder_type && !selectedFunders.includes(o.funder_type))
        return false;
      if (
        selectedLevels.length > 0 &&
        o.experience_level &&
        !selectedLevels.includes(o.experience_level)
      )
        return false;
      return true;
    });
  }, [visibleOpps, selectedFunders, selectedLevels]);

  const showLoadingState = isPolling && opportunities.length === 0;

  const handleSectionChange = (section: SidebarSection) => {
    setActiveSection(section);
  };

  if (loading) {
    return (
      <div className="gf-projectLayout">
        <ProjectSidebar
          project={project}
          activeSection={activeSection}
          onSectionChange={handleSectionChange}
          onBack={onBack}
          isLoading
        />
        <div className="gf-main">
          <div className="gf-loading">
            <div className="gf-spinner" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="gf-projectLayout">
      <ProjectSidebar
        project={project}
        activeSection={activeSection}
        onSectionChange={handleSectionChange}
        onBack={onBack}
        isLoading={isPolling}
      />
      <div className="gf-main">
        <div className="gf-mainContent">
          {activeSection === 'search_criteria' ? (
            <SearchSettings
              project={project}
              researchSummary={detail?.research_summary ?? project.research_summary ?? ''}
              onUpdateSummary={(s) => {
                if (detail) {
                  setDetail({ ...detail, research_summary: s });
                }
              }}
            />
          ) : (
            <>
              {!showLoadingState && (
                <div className="gf-statusTracking">
                  <div className="gf-statusTracking__header">
                    <span className="gf-statusTracking__title">Track your funding progress</span>
                  </div>
                  <StatusCountCards matchCount={opportunities.length} savedCount={saved.length} />
                </div>
              )}

              {showLoadingState && (
                <div className="gf-loadingState">
                  <div className="gf-loadingState__message">
                    <div className="gf-spinner" />
                    <div className="gf-loadingState__text">
                      <p>Matching you with relevant funding opportunities</p>
                      <p className="gf-loadingState__sub">This may take up to a minute</p>
                    </div>
                  </div>
                  <div className="gf-loadingState__box" />
                </div>
              )}

              {!showLoadingState &&
                activeSection === 'funding_opportunities' &&
                (funderTypes.length > 0 || expLevels.length > 0) && (
                  <GrantFilters
                    funderTypes={funderTypes}
                    experienceLevels={expLevels}
                    selectedFunders={selectedFunders}
                    selectedLevels={selectedLevels}
                    onFunderChange={setSelectedFunders}
                    onLevelChange={setSelectedLevels}
                  />
                )}

              {!showLoadingState && activeSection === 'saved_opportunities' && saved.length === 0 ? (
                <SavedEmptyState
                  onViewMatches={() => handleSectionChange('funding_opportunities')}
                />
              ) : !showLoadingState ? (
                <div className="gf-results">
                  {activeSection === 'funding_opportunities' && (
                    <div className="gf-results__header">
                      <span className="gf-results__count">
                        {filtered.length} match{filtered.length !== 1 ? 'es' : ''}, updated weekly
                      </span>
                      <button className="gf-btn gf-btn--sm gf-btn--secondary" onClick={() => handleSectionChange('search_criteria')}>
                        Refine your search
                      </button>
                    </div>
                  )}
                  <div className="gf-results__list">
                    {filtered.map((opp) => (
                      <OpportunityCard
                        key={opp.id}
                        opp={opp}
                        projectId={project.id}
                        onAction={fetchDetail}
                      />
                    ))}
                    {filtered.length === 0 && (
                      <div className="gf-results__empty">
                        {visibleOpps.length > 0
                          ? 'No results match your filters.'
                          : 'No matches found. Results may still be processing -- check back shortly.'}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Onboarding ─────────────────────────────────────────────

function Onboarding({ onCreated }: { onCreated: () => void }) {
  const [summary, setSummary] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inputMethod, setInputMethod] = useState<'upload' | 'manual'>('upload');
  const [uploadedFile, setUploadedFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setFileError('');
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== 'pdf' && ext !== 'txt') {
      setFileError('Unsupported format. Please upload a PDF or TXT file.');
      return;
    }
    try {
      const text = await file.text();
      setUploadedFile({ name: file.name, text });
      setSummary(text);
    } catch {
      setFileError('Failed to read file.');
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  };

  const handleCreate = async () => {
    if (!summary.trim() || !name.trim()) return;
    setLoading(true);
    setError('');
    try {
      await api('POST', `${BASE}/create_project`, {
        research_summary: summary,
        name: name.trim(),
      });
      onCreated();
    } catch (e: any) {
      setError(e.message || 'Failed to create project');
    } finally {
      setLoading(false);
    }
  };

  const canSubmit = name.trim() && summary.trim();

  return (
    <div className="gf-onboarding">
      <div className="gf-onboarding__card">
        <h1 className="gf-onboarding__title">Start a new grant project</h1>
        <div className="gf-onboarding__separator" />

        <label className="gf-label">Grant project name *</label>
        <input
          className="gf-input"
          placeholder="e.g. CRISPR Optimization Study"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <h2 className="gf-onboarding__sectionTitle">Add your research focus to find funding opportunities</h2>

        <div className="gf-onboarding__inputMethodToggle">
          <button
            className={`gf-onboarding__inputMethodBtn${inputMethod === 'upload' ? ' gf-onboarding__inputMethodBtn--active' : ''}`}
            onClick={() => setInputMethod('upload')}
          >
            Upload a research plan
          </button>
          <button
            className={`gf-onboarding__inputMethodBtn${inputMethod === 'manual' ? ' gf-onboarding__inputMethodBtn--active' : ''}`}
            onClick={() => setInputMethod('manual')}
          >
            Enter research focus manually
          </button>
        </div>

        {inputMethod === 'manual' ? (
          <>
            <label className="gf-label">
              Research summary *
              <span className="gf-label__sub">Describe your research focus, methodology, and goals</span>
            </label>
            <textarea
              className="gf-textarea"
              placeholder="Describe your research focus, methodology, goals, and target outcomes in detail. More detail produces better matches."
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </>
        ) : (
          <>
            <label className="gf-label">
              Research plan *
              <span className="gf-label__sub">Upload a research plan from your past or current proposals</span>
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt"
              style={{ display: 'none' }}
              onChange={handleFileInput}
            />
            {uploadedFile ? (
              <div className="gf-onboarding__uploadedFile">
                <span className="gf-onboarding__uploadedFileName">{uploadedFile.name}</span>
                <button
                  className="gf-onboarding__uploadedFileRemove"
                  onClick={() => { setUploadedFile(null); setSummary(''); }}
                >
                  <CloseIcon size={14} />
                </button>
              </div>
            ) : (
              <div
                className="gf-onboarding__dropzone"
                onClick={() => fileInputRef.current?.click()}
              >
                <p className="gf-onboarding__dropzoneText">
                  Drag and drop your file here or <span className="gf-onboarding__dropzoneLink">upload your file</span>
                </p>
                <p className="gf-onboarding__dropzoneSub">Supported formats: PDF, TXT</p>
              </div>
            )}
            {fileError && <div className="gf-error">{fileError}</div>}
          </>
        )}

        {error && <div className="gf-error">{error}</div>}

        <button
          className="gf-btn gf-btn--primary gf-btn--block"
          onClick={handleCreate}
          disabled={loading || !canSubmit}
        >
          {loading && <span className="gf-spinner gf-spinner--btn" />}
          Find funding opportunities
        </button>
      </div>
    </div>
  );
}

// ── ProjectCard ────────────────────────────────────────────

function ProjectCard({
  project,
  onClick,
}: {
  project: GrantProject;
  onClick: () => void;
}) {
  return (
    <button className="gf-projectCard" onClick={onClick}>
      <div className="gf-projectCard__main">
        <div className="gf-projectCard__name">{project.name}</div>
      </div>
      <div className="gf-projectCard__details">
        <span className="gf-projectCard__icon">
          <ControlCameraIcon />
        </span>
        <div className="gf-projectCard__info">
          <span className="gf-projectCard__infoTitle">Research focus</span>
          <span className="gf-projectCard__infoDate">{formatDate(project.created_at)}</span>
        </div>
      </div>
    </button>
  );
}

// ── ProjectsList ───────────────────────────────────────────

function ProjectsList({
  projects,
  onSelect,
  onNewSearch,
}: {
  projects: GrantProject[];
  onSelect: (p: GrantProject) => void;
  onNewSearch: () => void;
}) {
  return (
    <div className="gf-projectsList">
      <div className="gf-projectsList__headerContainer">
        <h1 className="gf-projectsList__title">Grant Projects</h1>
        <p className="gf-projectsList__subtitle">
          Receive funding opportunities based on your research interests and previous grant proposals.
        </p>
      </div>
      <div className="gf-projectsList__grid">
        <button className="gf-newProjectCard" onClick={onNewSearch}>
          <div className="gf-newProjectCard__iconArea">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="#91919e" strokeWidth="1.5">
              <circle cx="24" cy="24" r="4" />
              <ellipse cx="24" cy="24" rx="20" ry="8" />
              <ellipse cx="24" cy="24" rx="20" ry="8" transform="rotate(60 24 24)" />
              <ellipse cx="24" cy="24" rx="20" ry="8" transform="rotate(120 24 24)" />
            </svg>
          </div>
          <span className="gf-newProjectCard__label">+ Start a new grant project</span>
        </button>
        {[...projects].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).map((p) => (
          <ProjectCard key={p.id} project={p} onClick={() => onSelect(p)} />
        ))}
      </div>
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────

export default function App() {
  const [projects, setProjects] = useState<GrantProject[] | null>(null);
  const [selected, setSelected] = useState<GrantProject | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const { projects: list } = await api('GET', `${BASE}/get_projects`);
      setProjects(list ?? []);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Loading state
  if (projects === null) {
    return (
      <div className="gf">
        <div className="gf-loading">
          <div className="gf-spinner" />
        </div>
      </div>
    );
  }

  // Project detail
  if (selected) {
    return (
      <div className="gf">
        <ProjectDetailView
          project={selected}
          onBack={() => {
            setSelected(null);
            loadProjects();
          }}
        />
      </div>
    );
  }

  // Onboarding (no projects)
  if (projects.length === 0) {
    return (
      <div className="gf">
        <Onboarding onCreated={loadProjects} />
      </div>
    );
  }

  // Projects list
  return (
    <div className="gf">
      <ProjectsList
        projects={projects}
        onSelect={setSelected}
        onNewSearch={() => {
          window.academiaAPI.setComposerText(
            'Create a new grant project based on files in my workspace folder.',
          );
        }}
      />
    </div>
  );
}
