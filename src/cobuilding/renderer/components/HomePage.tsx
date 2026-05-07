import React, { useState, useEffect } from 'react';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';
import { ArrowUpRightIcon, HistoryIcon, SparklesIcon, XIcon } from 'lucide-react';
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

function formatDate(): string {
  const now = new Date();
  const day = now.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
  const date = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' }).toUpperCase();
  return `${day}, ${date}`;
}
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
        eyebrow: 'I can do this for you',
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
  onSelectFile: _onSelectFile,
  onSwitchToChat,
}: {
  workspacePath: string;
  onSelectFile: (filePath: string) => void;
  onSwitchToChat: () => void;
}) {
  const [briefings, setBriefings] = useState<ParsedBriefing[]>([]);
  const [view, setView] = useState<'home' | 'history'>('home');
  const [freeformInput, setFreeformInput] = useState('');
  const assistantRuntime = useAssistantRuntime();
  const composerRuntime = useComposerRuntime();

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
    // Re-fetch whenever briefings are created, updated, or change status.
    return window.briefingsAPI.onChanged(refresh);
  }, []);

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
    return <BriefingHistory onBack={() => setView('home')} workspacePath={workspacePath} onSwitchToChat={onSwitchToChat} />;
  }

  return (
    <div className="pageShell">
      <div className="pageShell__inner homePageInner">
        <div className="homeHeader">
          <div className="pageShell__stats">{formatDate()}</div>
          <h1 className="homeHeader__title">From reading your work</h1>
          <p className="homeHeader__subtitle">
            A few things I noticed I could do for you. Pick what would help.
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
            })
          )}

          <div className="homeBriefingCard homeBriefingCard--action homeFreeformCard">
            <div className="homeFreeformCard__heading">
              <SparklesIcon style={{ width: 16, height: 16, flexShrink: 0 }} />
              <span>Anything else I can help with?</span>
            </div>
            <p className="homeFreeformCard__subtitle">
              Tell me what you need — I'll do it now, or build a tool if it's worth keeping around.
            </p>
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
