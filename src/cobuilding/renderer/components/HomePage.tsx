import React, { useState, useEffect, useRef } from 'react';
import { ensureAccessibilityPermission } from '../utils/ensureAccessibilityPermission';
import { resolveWorkspacePath } from '../utils/resolveWorkspacePath';
import { pushPendingAttribution } from '../coscientistAnalytics';
import { buildSuggestedToolPrompt } from '../../shared/suggestedTasksTools';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';
import {
  ArrowUpRightIcon,
  CalendarIcon,
  CircleHelpIcon,
  FileTextIcon,
  HistoryIcon,
  LayoutGridIcon,
  PencilIcon,
  QuoteIcon,
  SparklesIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { BriefingHistory } from './BriefingHistory';

/** A briefing with its `briefing_data` JSON parsed into a typed payload. */
type ParsedBriefing =
  | { briefing: Briefing; type: 'suggested_tool'; data: BriefingDataSuggestedTool }
  | { briefing: Briefing; type: 'suggested_action'; data: BriefingDataSuggestedAction }
  | { briefing: Briefing; type: 'paper'; data: BriefingDataPaper }
  | { briefing: Briefing; type: 'citation'; data: BriefingDataCitation }
  | { briefing: Briefing; type: 'grant'; data: BriefingDataGrant }
  | { briefing: Briefing; type: 'writing_agent'; data: BriefingDataWritingAgent };

function parseBriefing(b: Briefing): ParsedBriefing | null {
  try {
    const data = JSON.parse(b.briefing_data);
    return { briefing: b, type: b.type, data } as ParsedBriefing;
  } catch {
    return null;
  }
}

function basename(filePath: string | undefined): string {
  if (!filePath) return '';
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function basenameNoExt(filePath: string | undefined): string {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.substring(0, dot) : name;
}

function formatDate(): string {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  const date = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }).toUpperCase();
  return `${day}, ${date}`;
}


interface BriefingCardDisplay {
  eyebrow: string;
  title: string;
  subtitle?: string;
  primaryLabel: string;
  fallbackDescription: string;
  Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

function renderBriefingCard(parsed: ParsedBriefing): BriefingCardDisplay | null {
  switch (parsed.type) {
    case 'suggested_action':
      return {
        eyebrow: 'I can do this for you',
        title: parsed.data.title,
        primaryLabel: 'Yes, do it',
        fallbackDescription: parsed.data.description,
        Icon: SparklesIcon,
      };
    case 'suggested_tool':
      return {
        eyebrow: 'I can build this for you',
        title: parsed.data.name,
        primaryLabel: 'Build it',
        fallbackDescription: parsed.data.details_on_what_to_build,
        Icon: LayoutGridIcon,
      };
    case 'paper':
      return {
        eyebrow: 'New paper',
        title: parsed.data.title,
        primaryLabel: 'Read it',
        fallbackDescription: parsed.data.abstract ?? '',
        Icon: FileTextIcon,
      };
    case 'citation':
      return {
        eyebrow: 'New citation',
        title: parsed.data.paper_title,
        primaryLabel: 'View',
        fallbackDescription: `Cited by ${parsed.data.citing_work}`,
        Icon: QuoteIcon,
      };
    case 'grant':
      return {
        eyebrow: 'Grant opportunity',
        title: parsed.data.title,
        primaryLabel: 'View',
        fallbackDescription: parsed.data.agency,
        Icon: CalendarIcon,
      };
    case 'writing_agent':
      return {
        eyebrow: 'I can do this for you',
        title: parsed.data.title || 'Peer review your manuscript',
        subtitle: basenameNoExt(parsed.data.file_path) || undefined,
        primaryLabel: 'Open in Word',
        fallbackDescription: parsed.data.description || `I'll read ${basename(parsed.data.file_path)} as a peer reviewer and flag concerns about the argument, evidence, methodology, and structure.`,
        Icon: PencilIcon,
      };
    default:
      return null;
  }
}

export function HomePage({
  workspacePath,
  userDirectoryPaths,
  onSelectFile: _onSelectFile,
  onSwitchToChat,
}: {
  workspacePath: string;
  userDirectoryPaths?: string[];
  onSelectFile: (filePath: string) => void;
  onSwitchToChat: () => void;
}) {
  const [briefings, setBriefings] = useState<ParsedBriefing[]>([]);
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const knownIdsRef = useRef<Set<string> | null>(null);
  const [view, setView] = useState<'home' | 'history'>('home');
  const [freeformInput, setFreeformInput] = useState('');
  const assistantRuntime = useAssistantRuntime();
  const composerRuntime = useComposerRuntime();

  useEffect(() => {
    const storageKey = `academia:seenBriefingIds:${workspacePath}`;

    let hasBaseline: boolean;
    if (knownIdsRef.current === null) {
      try {
        const raw = localStorage.getItem(storageKey);
        knownIdsRef.current = raw ? new Set(JSON.parse(raw)) : new Set();
        hasBaseline = !!raw;
      } catch {
        knownIdsRef.current = new Set();
        hasBaseline = false;
      }
    } else {
      hasBaseline = true;
    }

    const refresh = () => {
      window.briefingsAPI
        .list({ status: ['new'], limit: 50 })
        .then((rows) => {
          const parsed = rows
            .map(parseBriefing)
            .filter((b): b is ParsedBriefing => b !== null);

          const currentIds = new Set(parsed.map((p) => p.briefing.id));
          const known = knownIdsRef.current ?? new Set<string>();
          const newlyArrived = new Set<string>();
          if (hasBaseline) {
            for (const id of currentIds) {
              if (!known.has(id)) newlyArrived.add(id);
            }
          } else {
            hasBaseline = true;
          }

          knownIdsRef.current = currentIds;
          try {
            localStorage.setItem(storageKey, JSON.stringify([...currentIds]));
          } catch {}

          setBriefings(parsed);
          if (newlyArrived.size > 0) {
            setHighlightedIds((prev) => new Set([...prev, ...newlyArrived]));
            setTimeout(() => {
              setHighlightedIds((prev) => {
                const next = new Set(prev);
                for (const id of newlyArrived) next.delete(id);
                return next;
              });
            }, 10000);
          }
        });
    };
    refresh();
    return window.briefingsAPI.onChanged(refresh);
  }, [workspacePath]);

  const sendChatPrompt = (prompt: string) => {
    assistantRuntime.switchToNewThread();
    onSwitchToChat();
    setTimeout(() => {
      composerRuntime.setText(prompt);
      composerRuntime.send();
    }, 100);
  };

  const updateBriefingStatus = (id: string, status: BriefingStatus) => {
    window.briefingsAPI.setStatus(id, status);
    setBriefings((prev) => prev.filter((b) => b.briefing.id !== id));
  };

  const handleOpenBriefing = async (parsed: ParsedBriefing) => {
    updateBriefingStatus(parsed.briefing.id, 'opened');
    if (parsed.type === 'suggested_action') {
      sendChatPrompt(parsed.data.chat_prompt);
    } else if (parsed.type === 'suggested_tool') {
      pushPendingAttribution(parsed.briefing.id);
      sendChatPrompt(buildSuggestedToolPrompt(parsed.data.name, parsed.data.details_on_what_to_build));
    } else if (parsed.type === 'writing_agent') {
      if (!(await ensureAccessibilityPermission())) return;
      const absolutePath = resolveWorkspacePath(parsed.data.file_path, workspacePath, userDirectoryPaths ?? []);
      const fileUrl = absolutePath.startsWith('file://')
        ? absolutePath
        : `file://${absolutePath}`;
      // Always start a fresh peer-review chat in the overlay, regardless of
      // whether the user already has past conversations on this doc. The
      // kickoff carries a unique id so the popup forces a new chat even if
      // the prompt text matches a previous one.
      if (parsed.data.chat_prompt) {
        try {
          await window.fileMonitorAPI.setOverlayKickoffForDocument(absolutePath, parsed.data.chat_prompt);
        } catch (err) {
          console.warn('[WritingAgent] Failed to stash kickoff:', err);
        }
      }
      window.fileMonitorAPI.openFile(fileUrl, 'com.microsoft.Word');
      // Snap Word to ~66% width and the overlay to the remaining ~33%.
      window.fileMonitorAPI.setDockRightForDocument(absolutePath, true);
    }
    // paper / citation / grant: action handlers will be added when those types ship.
  };

  const handleDismissBriefing = (id: string) => {
    updateBriefingStatus(id, 'dismissed');
  };

  if (view === 'history') {
    return <BriefingHistory onBack={() => setView('home')} workspacePath={workspacePath} onSwitchToChat={onSwitchToChat} />;
  }

  return (
    <div className="pageShell">
      <div className="pageShell__inner homePageInner">
        <div className="homeHeader">
          <div className="pageShell__stats">{formatDate()}</div>
          <h1 className="homeHeader__title">Things I noticed I could do for you</h1>
          <p className="homeHeader__subtitle">
            Pick what would help.
          </p>
        </div>

        <div className="homeBriefingList">
          {briefings.length === 0 ? (
            <div className="homeSection__empty">No new briefings.</div>
          ) : (
            briefings.map((parsed) => {
              const card = renderBriefingCard(parsed);
              if (!card) return null;
              return (
                <div
                  key={parsed.briefing.id}
                  className={`homeBriefingCard homeBriefingCard--action${highlightedIds.has(parsed.briefing.id) ? ' homeBriefingCard--newArrival' : ''}`}
                >
                  <div className="homeBriefingCard__iconBox">
                    <card.Icon className="homeBriefingCard__icon" />
                  </div>
                  <div className="homeBriefingCard__body">
                    <div className="homeBriefingCard__eyebrow">
                      <span className="homeBriefingCard__eyebrowLabel">{card.eyebrow}</span>
                    </div>
                    <h3 className="homeBriefingCard__title">{card.title}</h3>
                    {card.subtitle && (
                      <p className="homeBriefingCard__subtitle">{card.subtitle}</p>
                    )}
                    <p className="homeBriefingCard__description">
                      {/* writing_agent always uses our peer-review copy; other
                          types prefer the briefing's own reason text. */}
                      {parsed.type === 'writing_agent'
                        ? card.fallbackDescription
                        : (parsed.briefing.why_im_suggesting_this ?? card.fallbackDescription)}
                      {parsed.type === 'suggested_tool' && parsed.briefing.why_im_suggesting_this && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button type="button" className="homeBriefingCard__infoBtn">
                              <CircleHelpIcon style={{ width: 14, height: 14 }} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="tooltipContent--wide" side="top">
                            {parsed.data.details_on_what_to_build}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </p>
                    <div className="homeBriefingCard__actions">
                      <button
                        type="button"
                        className="homeBriefingCard__button homeBriefingCard__button--primary"
                        onClick={() => handleOpenBriefing(parsed)}
                      >
                        {card.primaryLabel}
                        <ArrowUpRightIcon className="homeBriefingCard__buttonIcon" />
                      </button>
                      <button
                        type="button"
                        className="homeBriefingCard__button homeBriefingCard__button--secondary"
                        onClick={() => handleDismissBriefing(parsed.briefing.id)}
                      >
                        Not now
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}

          <div className="homeBriefingCard homeBriefingCard--action homeFreeformCard">
            <div className="homeFreeformCard__heading">
              <SparklesIcon
                style={{ width: 16, height: 16, flexShrink: 0, color: '#6b3c10' }}
              />
              <span>What else can I do for you?</span>
            </div>
            <div className="homeFreeformCard__inputRow">
              <input
                type="text"
                className="homeFreeformCard__input"
                placeholder="Help me draft a cover letter... find papers on... quantify these images..."
                value={freeformInput}
                onChange={(e) => setFreeformInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && freeformInput.trim()) {
                    sendChatPrompt(freeformInput.trim());
                    setFreeformInput('');
                  }
                }}
              />
              <button
                type="button"
                className="homeFreeformCard__sendButton"
                disabled={!freeformInput.trim()}
                onClick={() => {
                  if (freeformInput.trim()) {
                    sendChatPrompt(freeformInput.trim());
                    setFreeformInput('');
                  }
                }}
              >
                <ArrowUpRightIcon style={{ width: 16, height: 16 }} />
              </button>
            </div>
          </div>

          <button
            type="button"
            className="homeBriefingList__historyLink"
            onClick={() => setView('history')}
          >
            <HistoryIcon style={{ width: 14, height: 14 }} />
            View past tasks
          </button>
        </div>
      </div>
    </div>
  );
}
