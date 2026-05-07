import React, { useState, useEffect } from 'react';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';
import { ArrowUpRightIcon, HistoryIcon, SparklesIcon, XIcon } from 'lucide-react';
import { BriefingHistory } from './BriefingHistory';

interface WorkingOnItem {
  file_path: string;
  description: string;
}

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

function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function parentDir(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

/** Derive a short tag from the file extension. */
function fileTag(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'docx': case 'doc': case 'gdoc': return 'DOCUMENT';
    case 'tex': case 'latex': return 'MANUSCRIPT';
    case 'md': case 'txt': case 'rtf': return 'DOCUMENT';
    case 'pdf': return 'PDF';
    case 'py': case 'r': case 'jl': case 'ipynb': return 'SCRIPT';
    case 'csv': case 'tsv': case 'xlsx': case 'xls': return 'DATA';
    case 'bib': return 'BIBLIOGRAPHY';
    case 'pptx': case 'ppt': return 'PRESENTATION';
    default: return 'FILE';
  }
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

const MAX_VISIBLE_CARDS = 3;

interface BriefingCardDisplay {
  eyebrow: string;
  title: string;
  primaryLabel: string;
  fallbackDescription: string;
}

function renderBriefingCard(parsed: ParsedBriefing): BriefingCardDisplay | null {
  switch (parsed.type) {
    case 'suggested_action':
      return {
        eyebrow: 'I can do this for you',
        title: parsed.data.title,
        primaryLabel: 'Yes, do it',
        fallbackDescription: parsed.data.description,
      };
    case 'suggested_tool':
      return {
        eyebrow: 'I can build this for you',
        title: parsed.data.name,
        primaryLabel: 'Build it',
        fallbackDescription: parsed.data.details_on_what_to_build,
      };
    case 'paper':
      return {
        eyebrow: 'New paper',
        title: parsed.data.title,
        primaryLabel: 'Read it',
        fallbackDescription: parsed.data.abstract ?? '',
      };
    case 'citation':
      return {
        eyebrow: 'New citation',
        title: parsed.data.paper_title,
        primaryLabel: 'View',
        fallbackDescription: `Cited by ${parsed.data.citing_work}`,
      };
    case 'grant':
      return {
        eyebrow: 'Grant opportunity',
        title: parsed.data.title,
        primaryLabel: 'View',
        fallbackDescription: parsed.data.agency,
      };
    case 'writing_agent':
      return {
        eyebrow: 'Writing Agent',
        title: basename(parsed.data.file_path),
        primaryLabel: 'Open in Word',
        fallbackDescription: parsed.data.description,
      };
    default:
      return null;
  }
}

export function HomePage({
  workspacePath,
  onSelectFile,
  onSwitchToChat,
}: {
  workspacePath: string;
  onSelectFile: (filePath: string) => void;
  onSwitchToChat: () => void;
}) {
  const [workingOnItems, setWorkingOnItems] = useState<WorkingOnItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [briefings, setBriefings] = useState<ParsedBriefing[]>([]);
  const [view, setView] = useState<'home' | 'history'>('home');
  const assistantRuntime = useAssistantRuntime();
  const composerRuntime = useComposerRuntime();

  useEffect(() => {
    window.reportsAPI.getLatest('directory_scan').then((report) => {
      if (!report) {
        setLoading(false);
        return;
      }
      if (report.what_youre_working_on) {
        try {
          const parsed = JSON.parse(report.what_youre_working_on);
          if (Array.isArray(parsed)) {
            setWorkingOnItems(
              parsed.filter((item: WorkingOnItem) => !basename(item.file_path).startsWith('~$')),
            );
          }
        } catch { /* ignore */ }
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const refresh = () => {
      window.briefingsAPI
        .list({ status: ['new'] })
        .then((rows) => {
          const parsed = rows
            .map(parseBriefing)
            .filter((b): b is ParsedBriefing => b !== null);
          setBriefings(parsed);
        });
    };
    refresh();
    // Re-fetch whenever briefings are created, updated, or change status —
    // covers async manuscript enrichment, paper-monitor inserts, etc.
    return window.briefingsAPI.onChanged(refresh);
  }, []);

  const visibleItems = workingOnItems.slice(0, MAX_VISIBLE_CARDS);

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
      sendChatPrompt(
        `Please build the following mini-app for me:\n\n${parsed.data.details_on_what_to_build}`,
      );
    } else if (parsed.type === 'writing_agent') {
      const absolutePath = `${workspacePath}/${parsed.data.file_path}`;
      const fileUrl = absolutePath.startsWith('file://')
        ? absolutePath
        : `file://${absolutePath}`;
      // Only auto-fire the kickoff for the first-ever conversation on this
      // doc. If the user already has chats here, just open Word + dock and
      // let them pick which past conversation to continue from the overlay.
      let existingSessions = 0;
      try {
        existingSessions = await window.sessionsAPI.countForDocument(absolutePath);
      } catch (err) {
        console.warn('[WritingAgent] countForDocument failed; defaulting to kickoff:', err);
      }
      if (existingSessions === 0 && parsed.data.chat_prompt) {
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
    return <BriefingHistory onBack={() => setView('home')} />;
  }

  return (
    <div className="pageShell">
      <div className="pageShell__inner">
        {/* Page header / Working On section */}
        <div className="pageShell__headerBlock">
          <div className="pageShell__stats">WORKSPACE &middot; {formatDate()}</div>
          <h1 className="pageShell__title">
            Working on
            {workingOnItems.length > 0 && (
              <span className="homeTitle__count"> &middot; {workingOnItems.length} active</span>
            )}
          </h1>
          <p className="pageShell__subtitle">
            Click a file to open it with the agent alongside
          </p>
        </div>

        {loading ? (
          <div className="homeSection__empty">Loading&hellip;</div>
        ) : workingOnItems.length === 0 ? (
          <div className="homeSection__empty">
            No active files detected yet.
          </div>
        ) : (
          <div className="homeCardGrid">
            {visibleItems.map((item) => (
              <button
                key={item.file_path}
                className="homeCard"
                onClick={() => onSelectFile(`${workspacePath}/${item.file_path}`)}
              >
                <div className="homeCard__top">
                  <span className="homeCard__tag">{fileTag(item.file_path)}</span>
                  <ArrowUpRightIcon className="homeCard__arrow" style={{ width: 14, height: 14 }} />
                </div>
                <div className="homeCard__title">
                  {basename(item.file_path)}
                </div>
                <div className="homeCard__path">
                  {parentDir(item.file_path) || item.file_path}
                </div>
                <div className="homeCard__description">
                  {item.description}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Briefing section */}
        <section className="homeSection homeSection--briefing">
          <div className="homeSection__headerRow">
            <h2 className="homeSection__heading">
              Briefing
              {briefings.length > 0 && (
                <span className="homeTitle__count">
                  {' '}&nbsp;{briefings.length} {briefings.length === 1 ? 'item' : 'items'}
                </span>
              )}
            </h2>
            <button
              type="button"
              className="homeSection__historyButton"
              onClick={() => setView('history')}
            >
              <HistoryIcon className="homeSection__historyIcon" />
              View briefing history
            </button>
          </div>
          <p className="homeSection__subtitle">
            What's worth your attention from your routines and from me
          </p>
          <div className="homeBriefingGrid">
            {briefings.map((parsed) => {
              const card = renderBriefingCard(parsed);
              if (!card) return null;
              return (
                <div
                  key={parsed.briefing.id}
                  className="homeBriefingCard homeBriefingCard--action"
                >
                  <button
                    type="button"
                    className="homeBriefingCard__close"
                    aria-label="Dismiss briefing"
                    onClick={() => handleDismissBriefing(parsed.briefing.id)}
                  >
                    <XIcon className="homeBriefingCard__closeIcon" />
                  </button>
                  <div className="homeBriefingCard__eyebrow">
                    <SparklesIcon className="homeBriefingCard__eyebrowIcon" />
                    <span>{card.eyebrow}</span>
                  </div>
                  <h3 className="homeBriefingCard__title">{card.title}</h3>
                  <p className="homeBriefingCard__description">
                    {parsed.briefing.why_im_suggesting_this ?? card.fallbackDescription}
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
                      Not Now
                    </button>
                  </div>
                </div>
              );
            })}

            {briefings.length < 2 && (
              <div className="homeBriefingCard homeBriefingCard--placeholder" />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
